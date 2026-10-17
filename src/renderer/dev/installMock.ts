import type { BuildingIndex, BuildingInfo, DetailParams, VoxelApi, VwgHeader } from '../../shared/contract';

/**
 * Browser-only dev stub (plain Chrome against the vite dev server, no Electron preload).
 * Installed only when `window.voxel` is missing; dropped from production builds.
 */
if (import.meta.env.DEV && typeof window !== 'undefined' && !window.voxel) {
  const blobs = new Map<string, ArrayBuffer>();
  const progress = new Set<(e: { stage: 'init'; pct: number; message: string }) => void>();
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const PAL: Array<[number, number, number]> = [[0, 0, 0], [96, 110, 100], [200, 180, 150], [170, 90, 70], [90, 90, 100], [120, 160, 200], [225, 220, 210]];

  class Vox {
    x: number[] = []; y: number[] = []; z: number[] = []; c: number[] = [];
    private set = new Set<string>();
    put(x: number, y: number, z: number, c: number): void {
      const k = `${x},${y},${z}`;
      if (this.set.has(k)) return;
      this.set.add(k);
      this.x.push(x); this.y.push(y); this.z.push(z); this.c.push(c);
    }
    toVwg(vs: number): ArrayBuffer {
      const n = this.x.length;
      const mn: [number, number, number] = [Infinity, Infinity, Infinity], mx: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < n; i++) {
        mn[0] = Math.min(mn[0], this.x[i]!); mx[0] = Math.max(mx[0], this.x[i]! + 1);
        mn[1] = Math.min(mn[1], this.y[i]!); mx[1] = Math.max(mx[1], this.y[i]! + 1);
        mn[2] = Math.min(mn[2], this.z[i]!); mx[2] = Math.max(mx[2], this.z[i]! + 1);
      }
      const header = {
        version: 1, voxelSize: vs, voxelCount: n,
        origin: { utmZone: 36, hemisphere: 'N', easting: 0, northing: 0, elevation: 0, epsg: 32636 },
        bbox: { latMin: 0, lonMin: 0, latMax: 1, lonMax: 1 }, extent: { min: mn, max: mx }, palette: PAL,
        stats: { voxelCount: n, buildingCount: 0, buildingsWithPhotos: 0, buildingsProcedural: 0, elapsedMs: 0 },
      } as VwgHeader;
      const hb = new TextEncoder().encode(JSON.stringify(header));
      const start = (8 + hb.length + 3) & ~3;
      const buf = new ArrayBuffer(start + 12 * n + ((2 * n + 3) & ~3));
      new DataView(buf).setUint32(4, hb.length, true);
      new Uint8Array(buf).set([0x56, 0x57, 0x47, 0x31], 0);
      new Uint8Array(buf).set(hb, 8);
      new Int32Array(buf, start, n).set(this.x);
      new Int32Array(buf, start + 4 * n, n).set(this.y);
      new Int32Array(buf, start + 8 * n, n).set(this.z);
      new Uint16Array(buf, start + 12 * n, n).set(this.c);
      return buf;
    }
  }

  const buildings: BuildingInfo[] = [];
  const city = (): void => {
    buildings.length = 0;
    const v = new Vox();
    for (let x = 0; x < 120; x++) for (let z = 0; z < 120; z++) v.put(x, 0, z, (x % 20 < 3 || z % 20 < 3) ? 4 : 1);
    let id = 100;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      const x0 = 8 + i * 22, z0 = 8 + j * 22, w = 10 + ((i * 3 + j) % 4) * 2, d = 9 + ((i + j * 2) % 3) * 2, hgt = 6 + ((i * 7 + j * 5) % 6) * 3;
      const l = (i + j) % 5 === 0; // L-shape
      const fp: Array<[number, number]> = l
        ? [[x0, z0], [x0 + w, z0], [x0 + w, z0 + d / 2], [x0 + w / 2, z0 + d / 2], [x0 + w / 2, z0 + d], [x0, z0 + d]]
        : [[x0, z0], [x0 + w, z0], [x0 + w, z0 + d], [x0, z0 + d]];
      const inside = (x: number, z: number): boolean => x >= x0 && x < x0 + w && z >= z0 && z < z0 + d && !(l && x >= x0 + w / 2 && z >= z0 + d / 2);
      for (let x = x0 - 1; x <= x0 + w; x++) for (let z = z0 - 1; z <= z0 + d; z++) {
        if (!inside(x, z)) continue;
        const edge = !inside(x - 1, z) || !inside(x + 1, z) || !inside(x, z - 1) || !inside(x, z + 1);
        for (let y = 1; y <= hgt; y++) if (edge || y === hgt) v.put(x, y, z, y === hgt ? 3 : 2);
      }
      buildings.push({ id: `way/${id++}`, kind: i % 2 ? 'residential' : 'commercial', levels: Math.round(hgt / 3), heightM: hgt, footprint: fp, baseY: 1, topY: hgt + 1 });
    }
    blobs.set('mock-city', v.toVwg(1));
  };

  const detail = (p: DetailParams): { vwg: ArrayBuffer; floorYs: number[] } => {
    const vs = p.voxelSize, W = Math.round(12 / vs), D = Math.round(9 / vs), H = Math.round(9 / vs), per = Math.round(H / 3);
    const v = new Vox();
    const floorYs = [0, per, 2 * per];
    for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
      for (const fy of floorYs) v.put(x, fy, z, 6);
      v.put(x, H, z, 3);
    }
    for (let y = 1; y < H; y++) for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
      const wall = x === 0 || z === 0 || x === W - 1 || z === D - 1;
      const part = !!p.interior?.enabled && x === Math.round(W / 2) && z > 3 && !(y % per < 3 * (1 / vs) / 4);
      const win = wall && z === 0 ? (Math.floor(x / (2 / vs)) % 2 === 1 && y % per > per * 0.35 && y % per < per * 0.8 && y > per * 0.3) : false;
      if ((wall && !win) || part) v.put(x, y, z, win ? 5 : 2);
    }
    return { vwg: v.toVwg(vs), floorYs };
  };

  const photo = (): string => {
    const c = document.createElement('canvas');
    c.width = 800; c.height = 600;
    const g = c.getContext('2d')!;
    g.fillStyle = '#9ec3ea'; g.fillRect(0, 0, 800, 600);
    g.fillStyle = '#c9b79c';
    g.beginPath(); g.moveTo(140, 120); g.lineTo(660, 70); g.lineTo(670, 520); g.lineTo(130, 500); g.closePath(); g.fill();
    g.fillStyle = '#4b6a8a';
    for (let r = 0; r < 3; r++) for (let k = 0; k < 4; k++) g.fillRect(180 + k * 120, 140 + r * 120 - k * 3, 60, 70);
    g.fillStyle = '#6b3b1f'; g.fillRect(380, 420, 70, 90);
    return c.toDataURL('image/jpeg', 0.9);
  };

  const mock: VoxelApi = {
    async generate(params) {
      city();
      for (let i = 0; i <= 5; i++) { progress.forEach((f) => f({ stage: 'init', pct: i * 20, message: 'mock' })); await sleep(40); }
      return {
        vwgPath: 'mock-city',
        stats: { voxelCount: 1, buildingCount: buildings.length, buildingsWithPhotos: 0, buildingsProcedural: buildings.length, elapsedMs: 200, buildingIndexPath: params.maxVoxels ? 'mock-index' : undefined },
      };
    },
    cancel: async () => undefined,
    readBuildingIndex: async () => ({ version: 1, buildings } satisfies BuildingIndex),
    pickPhoto: async () => ({ photoPath: '/mock/facade.jpg', previewUrl: photo() }),
    async analyzeFacade(p) {
      await sleep(300);
      const W = p.wallWidthM, H = p.wallHeightM;
      const windows = [];
      for (let r = 0; r < 3; r++) for (let k = 0; k < 4; k++) windows.push({ u: W * (0.1 + k * 0.22), v: H * (0.12 + r * 0.3), w: W * 0.11, h: H * 0.16 });
      return {
        rectifiedPath: '/mock/rect.png',
        spec: {
          version: 1, wallWidthM: W, wallHeightM: H, floors: 3, floorLinesV: [H / 3, (2 * H) / 3], wallColour: [201, 183, 156],
          trimColour: [235, 230, 220], glassColour: [75, 106, 138], material: 'plaster', windows,
          doors: [{ u: W * 0.45, v: 0, w: 1, h: 2.1 }], confidence: { floors: 0.8, windows: 0.4, doors: 0.7, colour: 0.9 },
        },
      };
    },
    async detail(p) {
      for (let i = 0; i <= 5; i++) { progress.forEach((f) => f({ stage: 'init', pct: i * 20, message: 'mock detail' })); await sleep(60); }
      const d = detail(p);
      blobs.set('mock-detail', d.vwg);
      return { vwgPath: 'mock-detail', stats: { voxelCount: 1, levels: 3, rooms: 6, windows: 12, doors: 1, elapsedMs: 300, floorYs: d.floorYs } };
    },
    exportAs: async () => null,
    readVwg: async (p) => blobs.get(p)!.slice(0),
    onProgress: (cb) => { progress.add(cb as never); return () => progress.delete(cb as never); },
    onWarning: () => () => undefined,
    onLog: () => () => undefined,
  };
  window.voxel = mock;
}
