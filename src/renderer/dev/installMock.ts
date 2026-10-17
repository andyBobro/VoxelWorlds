import type {
  BBox, BuildingIndex, BuildingInfo, DataSource, DetailRecord, DetailStats, GenerateParams, GenerateStats, GeodataEntry,
  GeodataProgress, GeodataRegion, Stage, VoxelApi, VwgHeader, WorldMeta,
} from '../../shared/contract';

/**
 * Browser-only dev stub (plain Chrome against the vite dev server, no Electron preload).
 * Installed only when `window.voxel` is missing; dropped from production builds.
 * Fakes the whole VoxelApi in memory: worlds library, saved details, Geofabrik catalogue with simulated
 * download progress / cancel / resume. Test hooks live on `window.__vwMock` (calls log, failure switches).
 */
if (import.meta.env.DEV && typeof window !== 'undefined' && !window.voxel) {
  const blobs = new Map<string, ArrayBuffer>();
  type ProgressEvt = { stage: Stage; pct: number; message: string; tile?: { done: number; total: number } };
  const progress = new Set<(e: ProgressEvt) => void>();
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const emit = (e: ProgressEvt): void => progress.forEach((f) => f(e));

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

  const city = (): { vwg: ArrayBuffer; buildings: BuildingInfo[] } => {
    const buildings: BuildingInfo[] = [];
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
    return { vwg: v.toVwg(1), buildings };
  };

  const detail = (p: { voxelSize: number; interior?: { enabled: boolean } }): { vwg: ArrayBuffer; floorYs: number[] } => {
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

  // ───────────── worlds library (in memory) ─────────────
  interface WorldSlot { meta: WorldMeta; buildings: BuildingInfo[] | null }
  const worlds = new Map<string, WorldSlot>();
  const detailBlobs = new Map<string, { voxelSize: number; interior: boolean }>();
  let curWorld: string | null = null;
  let uid = 1;
  const newId = (p: string): string => `${p}-${(uid++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const savedCbs = new Set<(e: { world: WorldMeta; detail?: DetailRecord }) => void>();
  const fireSaved = (world: WorldMeta, detail?: DetailRecord): void => {
    const e = structuredClone({ world, detail });
    savedCbs.forEach((f) => f(e));
  };
  const geoCbs = new Set<(e: GeodataProgress) => void>();
  const log = { calls: [] as Array<{ fn: string; args: unknown }>, offline: false, failNextDownload: false, saveFail: false, bigLibrary: false, speedMul: 1, genDelay: 0 };
  const rec = (fn: string, args: unknown): void => { log.calls.push({ fn, args }); };
  const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

  const mkStats = (n: number, b: number): GenerateStats => ({
    voxelCount: n, buildingCount: b, buildingsWithPhotos: 0, buildingsProcedural: b, elapsedMs: 200, buildingIndexPath: 'mock-index',
  });
  const centreName = (b: BBox): string => `${((b.latMin + b.latMax) / 2).toFixed(3)}, ${((b.lonMin + b.lonMax) / 2).toFixed(3)} ${new Date().toISOString().slice(0, 10)}`;
  const touch = (w: WorldMeta): void => {
    w.updatedAt = new Date().toISOString();
    w.sizeBytes = 3_400_000 + w.details.reduce((s, d) => s + d.sizeBytes, 0);
  };
  const baseParams = (bbox: BBox, voxelSize: number, dataSource?: DataSource): WorldMeta['params'] => ({
    bbox, voxelSize, tileSize: 500, workers: 0, features: { roads: true, elevation: true, proceduralFacades: true },
    metersPerFloor: 3.5, defaultBuildingHeight: 10.5, maxVoxels: 50_000_000, ...(dataSource ? { dataSource } : {}),
  });
  const mkDetail = (worldId: string, buildingId: string, voxelSize: number, interior: boolean, edge: number | undefined, days: number): DetailRecord => {
    const id = newId('d');
    detailBlobs.set(id, { voxelSize, interior });
    return {
      id, worldId, buildingId, createdAt: iso(days), voxelSize, interior, ...(edge !== undefined ? { facade: { edge } } : {}),
      stats: { voxelCount: Math.round(900_000 * (0.15 / voxelSize)), levels: 3, rooms: interior ? 6 : 0, windows: 12, doors: 1, elapsedMs: 300, floorYs: [] },
      sizeBytes: Math.round(2_400_000 * (0.15 / voxelSize)),
    };
  };
  const seed = (name: string, bbox: BBox, days: number, ds: DataSource | undefined, detailSpecs: Array<[string, number, boolean, number | undefined]>): void => {
    const id = newId('w');
    const c = city();
    const meta: WorldMeta = {
      id, name, createdAt: iso(days), updatedAt: iso(days), bbox, voxelSize: 1, params: baseParams(bbox, 1, ds),
      stats: mkStats(21_000, c.buildings.length), sizeBytes: 0, hasBuildingIndex: true, details: [],
    };
    if (ds?.kind === 'pbf') meta.sourceInfo = { sizeBytes: 80_000_000, sourceDate: iso(30) };
    meta.details = detailSpecs.map(([b, vs, inter, edge], i) => mkDetail(id, b, vs, inter, edge, days - 0.1 * (i + 1)));
    touch(meta);
    meta.updatedAt = iso(days);
    worlds.set(id, { meta, buildings: null });
  };
  seed('Zurich Altstadt', { latMin: 47.369, lonMin: 8.538, latMax: 47.375, lonMax: 8.548 }, 3, { kind: 'overpass' },
    [['way/102', 0.15, true, 1], ['way/107', 0.2, false, undefined], ['way/102', 0.25, false, 0]]);
  seed('Berlin Mitte offline', { latMin: 52.515, lonMin: 13.37, latMax: 52.522, lonMax: 13.385 }, 9, { kind: 'pbf', regionId: 'germany/berlin' },
    [['way/110', 0.15, true, undefined]]);

  const worldBuildings = (id: string): BuildingInfo[] => {
    const w = worlds.get(id)!;
    return (w.buildings ??= city().buildings);
  };

  // ───────────── geodata catalogue (fake Geofabrik) ─────────────
  type Box = [number, number, number, number]; // latMin lonMin latMax lonMax
  interface FakeRegion extends GeodataRegion { box: Box }
  const R = (id: string, name: string, parent: string | undefined, mb: number | undefined, box: Box): FakeRegion => ({
    id, name, ...(parent ? { parent } : {}), pbfUrl: `https://download.geofabrik.de/${id}-latest.osm.pbf`,
    ...(mb !== undefined ? { sizeBytes: Math.round(mb * 1e6) } : {}), box,
  });
  const CATALOGUE: FakeRegion[] = [
    R('europe', 'Europe', undefined, 30_100, [34, -32, 72, 70]),
    R('switzerland', 'Switzerland', 'europe', 480, [45.7, 5.9, 47.9, 10.6]),
    R('liechtenstein', 'Liechtenstein', 'europe', 3.1, [47.04, 9.47, 47.28, 9.64]),
    R('germany', 'Germany', 'europe', 4_300, [47.2, 5.8, 55.1, 15.1]),
    R('germany/berlin', 'Berlin', 'germany', 82, [52.33, 13.08, 52.68, 13.77]),
    R('germany/bayern', 'Bayern', 'germany', 880, [47.2, 8.9, 50.6, 13.9]),
    R('germany/hamburg', 'Hamburg', 'germany', 41, [53.38, 9.7, 53.75, 10.35]),
    R('france', 'France', 'europe', 4_400, [41.2, -5.5, 51.2, 9.8]),
    R('france/ile-de-france', 'Île-de-France', 'france', 330, [48.1, 1.4, 49.25, 3.6]),
    R('austria', 'Austria', 'europe', 770, [46.3, 9.5, 49.1, 17.2]),
    R('great-britain', 'Great Britain', 'europe', 1_900, [49.8, -8.7, 60.9, 1.9]),
    R('asia', 'Asia', undefined, 14_300, [-11, 25, 78, 180]),
    R('israel-and-palestine', 'Israel and Palestine', 'asia', 123, [29.4, 34.2, 33.4, 35.95]),
    R('japan', 'Japan', 'asia', 2_100, [24, 122, 46, 146]),
    R('japan/kanto', 'Kantō', 'japan', 610, [34.8, 138.2, 37, 141]),
    R('north-america', 'North America', undefined, 13_200, [5, -180, 84, -10]),
    R('us', 'United States', 'north-america', 9_200, [18, -180, 72, -66]),
    R('us/california', 'California', 'us', 1_300, [32.4, -124.5, 42.1, -114.1]),
    R('africa', 'Africa', undefined, 7_100, [-35, -26, 38, 64]),
    R('antarctica', 'Antarctica', undefined, undefined, [-90, -180, -60, 180]),
  ];
  const entries = new Map<string, GeodataEntry>();
  const partial = new Map<string, number>();
  const cancelFlags = new Set<string>();
  entries.set('germany/berlin', {
    regionId: 'germany/berlin', name: 'Berlin', pbfPath: '/mock/geodata/berlin-latest.osm.pbf', sizeBytes: 82_000_000,
    downloadedAt: iso(12), sourceDate: iso(13), verified: true,
  });
  let catalogueDate = iso(2);
  const withDl = (r: FakeRegion): GeodataRegion => {
    const { box: _box, ...rest } = r;
    void _box;
    return { ...rest, downloaded: entries.has(r.id) };
  };
  const intersects = (r: FakeRegion, b: BBox): boolean => r.box[0] <= b.latMax && r.box[2] >= b.latMin && r.box[1] <= b.lonMax && r.box[3] >= b.lonMin;
  const covers = (r: FakeRegion, b: BBox): boolean => r.box[0] <= b.latMin && r.box[1] <= b.lonMin && r.box[2] >= b.latMax && r.box[3] >= b.lonMax;

  const need = <T>(v: T | undefined, msg: string): T => {
    if (v === undefined) throw new Error(msg);
    return v;
  };

  const mock: VoxelApi = {
    async generate(params: GenerateParams) {
      rec('generate', params);
      const c = city();
      const ds = params.dataSource;
      if (ds?.kind === 'pbf') {
        if (!entries.has(ds.regionId)) throw new Error('PBF_NO_COVERAGE: region not downloaded');
        for (let i = 0; i <= 4; i++) { emit({ stage: 'pbf', pct: i * 25, message: `${(i * 0.9).toFixed(1)}M of 3.6M elements scanned` }); await sleep(120); }
      }
      for (let i = 0; i <= 5; i++) { emit({ stage: 'init', pct: i * 20, message: 'mock' }); await sleep(40 + log.genDelay); }
      const id = newId('w');
      blobs.set(`mock-world-${id}`, c.vwg);
      const { mapillaryToken: _t, ...saved } = params;
      void _t;
      const meta: WorldMeta = {
        id, name: centreName(params.bbox), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        bbox: params.bbox, voxelSize: params.voxelSize, params: saved, stats: mkStats(21_000, c.buildings.length),
        sizeBytes: 0, hasBuildingIndex: true, details: [],
      };
      touch(meta);
      worlds.set(id, { meta, buildings: c.buildings });
      curWorld = id;
      const stats = { ...meta.stats, buildingIndexPath: `mock-index-${id}` };
      if (log.saveFail) {
        worlds.delete(id);
        curWorld = null;
        return { vwgPath: `mock-world-${id}`, stats, saveError: 'ENOSPC: no space left on device' };
      }
      fireSaved(meta);
      return { vwgPath: `mock-world-${id}`, stats, world: structuredClone(meta) };
    },
    cancel: async () => undefined,
    async readBuildingIndex(path) {
      const id = path.replace('mock-index-', '');
      return { version: 1, buildings: worlds.has(id) ? worldBuildings(id) : city().buildings } satisfies BuildingIndex;
    },
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
      rec('detail', p);
      for (let i = 0; i <= 5; i++) { emit({ stage: 'interior', pct: i * 20, message: 'mock detail' }); await sleep(60); }
      const d = detail({ voxelSize: p.voxelSize, interior: p.interior });
      const w = (p.worldId ? worlds.get(p.worldId) : undefined) ?? undefined;
      if (p.worldId && !w) throw new Error('WORLD_NOT_FOUND: no such world');
      let record: DetailRecord | undefined;
      if (w) {
        record = mkDetail(w.meta.id, p.ref.buildingId, p.voxelSize, !!p.interior?.enabled, p.facade?.edge, 0);
        record.stats = { voxelCount: 1, levels: 3, rooms: 6, windows: 12, doors: 1, elapsedMs: 300, floorYs: d.floorYs };
        w.meta.details = [record, ...w.meta.details];
        touch(w.meta);
        blobs.set(`mock-detail-${record.id}`, d.vwg);
      } else blobs.set('mock-detail', d.vwg);
      const stats: DetailStats = { voxelCount: 1, levels: 3, rooms: 6, windows: 12, doors: 1, elapsedMs: 300, floorYs: d.floorYs };
      if (w && record) fireSaved(w.meta, record);
      return { vwgPath: record ? `mock-detail-${record.id}` : 'mock-detail', stats, record };
    },

    async listWorlds() {
      rec('listWorlds', null);
      return [...worlds.values()].map((w, i) => { const m = structuredClone(w.meta); if (log.bigLibrary && i === 0) m.sizeBytes += 1.6e9; return m; }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async openWorld(worldId) {
      rec('openWorld', worldId);
      await sleep(120);
      const w = need(worlds.get(worldId), 'WORLD_NOT_FOUND: no such world');
      curWorld = worldId;
      const b = worldBuildings(worldId);
      const c = city();
      blobs.set(`mock-world-${worldId}`, c.vwg);
      w.buildings = b;
      return { vwgPath: `mock-world-${worldId}`, stats: { ...w.meta.stats, buildingIndexPath: `mock-index-${worldId}` }, buildingIndexPath: `mock-index-${worldId}`, meta: structuredClone(w.meta) };
    },
    async renameWorld(worldId, name) {
      rec('renameWorld', { worldId, name });
      const w = need(worlds.get(worldId), 'WORLD_NOT_FOUND: no such world');
      const n = name.trim();
      if (!n) throw new Error('BAD_REQUEST: name must not be empty');
      w.meta.name = n;
      touch(w.meta);
      return structuredClone(w.meta);
    },
    async deleteWorld(worldId) {
      rec('deleteWorld', worldId);
      if (!worlds.delete(worldId)) throw new Error('WORLD_NOT_FOUND: no such world');
      if (curWorld === worldId) curWorld = null;
    },
    async listDetails(worldId) {
      rec('listDetails', worldId);
      return structuredClone(worlds.get(worldId)?.meta.details ?? []);
    },
    async openDetail(worldId, detailId) {
      rec('openDetail', { worldId, detailId });
      await sleep(80);
      const w = need(worlds.get(worldId), 'WORLD_NOT_FOUND: no such world');
      const r = need(w.meta.details.find((d) => d.id === detailId), 'WORLD_NOT_FOUND: no such detail');
      const spec = detailBlobs.get(detailId) ?? { voxelSize: r.voxelSize, interior: r.interior };
      const d = detail({ voxelSize: spec.voxelSize, interior: { enabled: spec.interior } });
      blobs.set(`mock-detail-${detailId}`, d.vwg);
      r.stats = { ...r.stats, floorYs: d.floorYs };
      return { vwgPath: `mock-detail-${detailId}`, stats: r.stats, record: structuredClone(r) };
    },
    async deleteDetail(worldId, detailId) {
      rec('deleteDetail', { worldId, detailId });
      const w = need(worlds.get(worldId), 'WORLD_NOT_FOUND: no such world');
      w.meta.details = w.meta.details.filter((d) => d.id !== detailId);
      touch(w.meta);
      fireSaved(w.meta);
    },
    onWorldSaved: (cb) => { savedCbs.add(cb); return () => savedCbs.delete(cb); },

    async listGeodataRegions(opts) {
      rec('listGeodataRegions', opts ?? null);
      await sleep(opts?.refresh ? 500 : 80);
      if (log.offline && opts?.refresh) throw new Error('DOWNLOAD_FAILED: getaddrinfo ENOTFOUND download.geofabrik.de');
      if (opts?.refresh) catalogueDate = new Date().toISOString();
      return CATALOGUE.map(withDl);
    },
    async suggestGeodataRegions(bbox) {
      rec('suggestGeodataRegions', bbox);
      await sleep(60);
      const bySize = (a: FakeRegion, b: FakeRegion): number => (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity);
      const cov = CATALOGUE.filter((r) => covers(r, bbox)).sort(bySize).map(withDl);
      const over = CATALOGUE.filter((r) => !covers(r, bbox) && intersects(r, bbox)).sort(bySize).map((r) => ({ ...withDl(r), covers: false }));
      return [...cov, ...over];
    },
    async listGeodata() {
      rec('listGeodata', null);
      return [...entries.values()].map((e) => ({ ...e }));
    },
    async downloadGeodata(regionId) {
      rec('downloadGeodata', regionId);
      const reg = need(CATALOGUE.find((r) => r.id === regionId), 'DOWNLOAD_FAILED: unknown region');
      if (entries.has(regionId)) return { ...entries.get(regionId)! };
      const total = reg.sizeBytes ?? 50_000_000;
      let got = partial.get(regionId) ?? 0; // resume
      cancelFlags.delete(regionId);
      const step = Math.max(500_000, total / 30) * log.speedMul;
      let last = performance.now(), lastGot = got;
      const send = (phase: GeodataProgress['phase'], extra: Partial<GeodataProgress> = {}): void =>
        geoCbs.forEach((f) => f({ regionId, phase, receivedBytes: got, totalBytes: total, ...extra }));
      while (got < total) {
        await sleep(200);
        if (cancelFlags.has(regionId)) {
          cancelFlags.delete(regionId);
          partial.set(regionId, got);
          send('error', { message: 'Cancelled' });
          throw new Error('CANCELLED: download cancelled');
        }
        if (log.failNextDownload && got > total * 0.4) {
          log.failNextDownload = false;
          partial.set(regionId, got);
          send('error', { message: 'Connection reset' });
          throw new Error('DOWNLOAD_FAILED: connection reset by peer');
        }
        got = Math.min(total, got + step);
        const now = performance.now();
        send('download', { bytesPerSec: ((got - lastGot) / Math.max(1, now - last)) * 1000 });
        last = now; lastGot = got;
      }
      send('verify', { message: 'Verifying checksum...' });
      await sleep(400);
      partial.delete(regionId);
      const e: GeodataEntry = {
        regionId, name: reg.name, pbfPath: `/mock/geodata/${regionId.replace('/', '-')}-latest.osm.pbf`, sizeBytes: total,
        downloadedAt: new Date().toISOString(), sourceDate: catalogueDate, verified: true,
      };
      entries.set(regionId, e);
      send('done');
      return { ...e };
    },
    async cancelGeodataDownload(regionId) {
      rec('cancelGeodataDownload', regionId ?? null);
      if (regionId) cancelFlags.add(regionId);
      else for (const r of CATALOGUE) cancelFlags.add(r.id);
    },
    async deleteGeodata(regionId) {
      rec('deleteGeodata', regionId);
      entries.delete(regionId);
      partial.delete(regionId);
    },
    onGeodataProgress: (cb) => { geoCbs.add(cb); return () => geoCbs.delete(cb); },

    exportAs: async (format, name, vwgPath) => { rec('exportAs', { format, name, vwgPath }); return null; },
    readVwg: async (p) => {
      const b = blobs.get(p);
      if (!b) throw new Error(`WORLD_NOT_FOUND: ${p}`);
      return b.slice(0);
    },
    onProgress: (cb) => { progress.add(cb as never); return () => progress.delete(cb as never); },
    onWarning: () => () => undefined,
    onLog: () => () => undefined,
  };
  window.voxel = mock;
  (window as unknown as Record<string, unknown>).__vwMock = log;
}
