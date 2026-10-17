import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BBox,
  DataSource,
  DetailParams,
  DetailRecord,
  DetailStats,
  GenerateParams,
  GenerateStats,
  WorldMeta,
} from '../shared/contract';
import { copyFileAtomic, dirSize, fileSize, fsyncDir, readJsonFile, SerialQueue, writeFileAtomic } from './fsutil';

/**
 * Worlds library (Electron-free so it is unit-testable; ipc.ts passes `<userData>/worlds`).
 *
 *   <root>/<worldId>/meta.json                  WorldMeta without `details` (details are derived from details/*.json)
 *   <root>/<worldId>/world.vwg
 *   <root>/<worldId>/world.buildings.json       optional
 *   <root>/<worldId>/details/<detailId>.vwg     + <detailId>.json (DetailRecord, written LAST = commit marker)
 *
 * A new world is assembled in `<root>/.tmp-<id>` and renamed into place after meta.json is written, so a crash never
 * leaves a half-written world visible. Directories without a valid meta.json + world.vwg are skipped with a log.
 * All mutations are serialised. Ids are validated against a strict pattern and must exist in the in-memory library.
 */

export const META_FILE = 'meta.json';
export const WORLD_VWG = 'world.vwg';
export const WORLD_INDEX = 'world.buildings.json';
export const DETAILS_DIR = 'details';
export const DAMAGED_DIR = '.damaged';
const DAMAGED_TTL_MS = 30 * 24 * 3600 * 1000;
const ORPHAN_AGE_MS = 3600 * 1000;

const ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
export const isValidId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id);

export class WorldError extends Error {
  constructor(
    public code: 'WORLD_NOT_FOUND' | 'BAD_REQUEST' | 'INTERNAL',
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

const num = (v: unknown, lo: number, hi: number, dflt: number): number => (fin(v) && v >= lo && v <= hi ? v : dflt);

function normDataSource(ds: unknown): DataSource {
  const d = ds as { kind?: unknown; regionId?: unknown } | undefined;
  if (d && d.kind === 'pbf' && typeof d.regionId === 'string' && d.regionId.length > 0 && d.regionId.length <= 200) {
    return { kind: 'pbf', regionId: d.regionId };
  }
  return { kind: 'overpass' };
}

/**
 * Whitelist + defaults for persisted generate params. Never throws, never keeps unknown fields: this drops
 * `mapillaryToken` and `pbfPath` and repairs missing/garbled values from older or hand-edited metas.
 */
export function normaliseParams(p: unknown, bbox: BBox, voxelSize: number): WorldMeta['params'] {
  const x = (p && typeof p === 'object' ? p : {}) as Record<string, any>;
  const f = (x.features && typeof x.features === 'object' ? x.features : {}) as Record<string, unknown>;
  const out: WorldMeta['params'] = {
    bbox: { ...bbox },
    voxelSize: num(x.voxelSize, 0.05, 5, voxelSize),
    features: {
      roads: f.roads !== false,
      elevation: f.elevation !== false,
      proceduralFacades: f.proceduralFacades !== false,
    },
    metersPerFloor: num(x.metersPerFloor, 0.5, 10, 3.5),
    defaultBuildingHeight: num(x.defaultBuildingHeight, 1, 1000, 10.5),
    maxVoxels: Number.isInteger(x.maxVoxels) && x.maxVoxels > 0 && x.maxVoxels <= 2_000_000_000 ? x.maxVoxels : 20_000_000,
    dataSource: normDataSource(x.dataSource),
  };
  if (fin(x.tileSize) && x.tileSize >= 50 && x.tileSize <= 5000) out.tileSize = x.tileSize;
  if (Number.isInteger(x.workers) && x.workers >= 0 && x.workers <= 16) out.workers = x.workers;
  return out;
}

/** Params to persist for a generate request (token and pbfPath stripped). */
export function sanitizeParams(p: GenerateParams): WorldMeta['params'] {
  return normaliseParams(p, p.bbox, p.voxelSize);
}

export function normaliseStats(s: unknown): GenerateStats {
  const x = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
  const n = (k: string): number => (fin(x[k]) && (x[k] as number) >= 0 ? (x[k] as number) : 0);
  const out: GenerateStats = {
    voxelCount: n('voxelCount'),
    buildingCount: n('buildingCount'),
    buildingsWithPhotos: n('buildingsWithPhotos'),
    buildingsProcedural: n('buildingsProcedural'),
    elapsedMs: n('elapsedMs'),
  };
  if (fin(x.tileCount) && x.tileCount >= 0) out.tileCount = x.tileCount;
  return out; // buildingIndexPath is machine-local and recomputed on open
}

function normaliseDetailStats(s: unknown): DetailStats {
  const x = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
  const n = (k: string): number => (fin(x[k]) && (x[k] as number) >= 0 ? (x[k] as number) : 0);
  const fy = Array.isArray(x.floorYs) ? x.floorYs.filter((v): v is number => Number.isInteger(v)).slice(0, 300) : [];
  return { voxelCount: n('voxelCount'), levels: n('levels'), rooms: n('rooms'), windows: n('windows'), doors: n('doors'), elapsedMs: n('elapsedMs'), floorYs: fy };
}

/** "<lat,lon> <YYYY-MM-DD HH:mm> · <source>" (local time; source = "Overpass" or the region name). */
export function defaultWorldName(bbox: BBox, now: Date = new Date(), source = 'Overpass'): string {
  const lat = (bbox.latMin + bbox.latMax) / 2;
  const lon = (bbox.lonMin + bbox.lonMax) / 2;
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
  return `${lat.toFixed(4)},${lon.toFixed(4)} ${stamp} · ${source}`;
}

export function cleanWorldName(name: unknown): string {
  if (typeof name !== 'string') throw new WorldError('BAD_REQUEST', 'name must be a string');
  // eslint-disable-next-line no-control-regex
  const n = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ');
  if (!n) throw new WorldError('BAD_REQUEST', 'name must not be empty');
  if (n.length > 120) throw new WorldError('BAD_REQUEST', 'name too long (max 120)');
  return n;
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) o[k] = stable(x);
    }
    return o;
  }
  return v;
}

/**
 * Identity of a detail result: same building + same options/spec => same id => overwrite instead of duplicate.
 * `maxVoxels` and the temp/bbox bits are excluded (they do not change the output); a disabled interior equals none.
 */
export function detailHash(p: DetailParams): string {
  const interior = p.interior && p.interior.enabled ? p.interior : null;
  const key = stable({
    b: p.ref.buildingId,
    v: p.voxelSize,
    f: p.facade ?? null,
    i: interior,
    n: !!p.includeNeighbours,
    m: p.ref.metersPerFloor ?? null,
    h: p.ref.defaultBuildingHeight ?? null,
  });
  return createHash('sha256').update(JSON.stringify(key)).digest('hex');
}

/** Deterministic id from the hash; valid per ID_RE ("d" + 24 hex). */
export const detailIdFor = (p: DetailParams): string => `d${detailHash(p).slice(0, 24)}`;

const validBBox = (b: any): b is BBox =>
  !!b && [b.latMin, b.lonMin, b.latMax, b.lonMax].every(fin) && b.latMin < b.latMax && b.lonMin < b.lonMax;

interface FilesInfo {
  vwgBytes?: number;
  indexBytes?: number;
}

/** Repair a parsed meta.json into a usable WorldMeta (defaults for missing/garbled fields), or null if hopeless. */
export function normaliseMeta(raw: unknown, id: string): { meta: WorldMeta; files: FilesInfo } | null {
  const x = raw as Record<string, any>;
  if (!x || typeof x !== 'object' || x.id !== id || !validBBox(x.bbox)) return null;
  const bbox: BBox = { latMin: x.bbox.latMin, lonMin: x.bbox.lonMin, latMax: x.bbox.latMax, lonMax: x.bbox.lonMax };
  const created = typeof x.createdAt === 'string' && !Number.isNaN(Date.parse(x.createdAt)) ? x.createdAt : new Date(0).toISOString();
  const updated = typeof x.updatedAt === 'string' && !Number.isNaN(Date.parse(x.updatedAt)) ? x.updatedAt : created;
  const params = normaliseParams(x.params, bbox, num(x.voxelSize, 0.05, 5, 1));
  const name = typeof x.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 120) : defaultWorldName(bbox, new Date(created), params.dataSource?.kind === 'pbf' ? params.dataSource.regionId : 'Overpass');
  const files: FilesInfo = {};
  if (x.files && typeof x.files === 'object') {
    if (Number.isInteger(x.files.vwgBytes) && x.files.vwgBytes > 0) files.vwgBytes = x.files.vwgBytes;
    if (Number.isInteger(x.files.indexBytes) && x.files.indexBytes > 0) files.indexBytes = x.files.indexBytes;
  }
  return {
    files,
    meta: {
      formatVersion: 1,
      id,
      name,
      createdAt: created,
      updatedAt: updated,
      bbox,
      voxelSize: params.voxelSize,
      params,
      stats: normaliseStats(x.stats),
      sizeBytes: fin(x.sizeBytes) && x.sizeBytes >= 0 ? x.sizeBytes : 0,
      ...(x.sourceInfo && fin(x.sourceInfo.sizeBytes) && x.sourceInfo.sizeBytes >= 0
        ? { sourceInfo: { sizeBytes: x.sourceInfo.sizeBytes, ...(typeof x.sourceInfo.sourceDate === 'string' ? { sourceDate: x.sourceInfo.sourceDate.slice(0, 64) } : {}) } }
        : {}),
      hasBuildingIndex: false,
      details: [],
    },
  };
}

export function normaliseDetail(r: unknown, worldId: string, id: string): { record: DetailRecord; vwgBytes?: number } | null {
  const x = r as Record<string, any>;
  if (!x || typeof x !== 'object' || x.id !== id || x.worldId !== worldId || typeof x.buildingId !== 'string' || !x.buildingId) return null;
  if (typeof x.createdAt !== 'string' || Number.isNaN(Date.parse(x.createdAt))) return null;
  const record: DetailRecord = {
    id,
    worldId,
    buildingId: x.buildingId,
    ...(typeof x.buildingName === 'string' && x.buildingName ? { buildingName: x.buildingName.slice(0, 120) } : {}),
    createdAt: x.createdAt,
    voxelSize: num(x.voxelSize, 0.001, 100, 0.15),
    interior: !!x.interior,
    ...(x.facade && Number.isInteger(x.facade.edge) && x.facade.edge >= 0 ? { facade: { edge: x.facade.edge } } : {}),
    stats: normaliseDetailStats(x.stats),
    sizeBytes: fin(x.sizeBytes) && x.sizeBytes >= 0 ? x.sizeBytes : 0,
  };
  return { record, ...(Number.isInteger(x.vwgBytes) && x.vwgBytes > 0 ? { vwgBytes: x.vwgBytes } : {}) };
}

export interface SavedWorld {
  meta: WorldMeta;
  vwgPath: string;
  buildingIndexPath?: string;
}

export interface SaveWorldInput {
  params: GenerateParams;
  stats: GenerateStats;
  vwgPath: string;
  buildingIndexPath?: string;
  /** identity of the local extract used (pbf worlds), to detect later updates */
  sourceInfo?: { sizeBytes: number; sourceDate?: string };
  /** shown in the default name: region name for pbf worlds (default "Overpass") */
  sourceLabel?: string;
  now?: Date;
}

export interface SaveDetailInput {
  worldId: string;
  params: DetailParams;
  stats: DetailStats;
  vwgPath: string;
  buildingName?: string;
  now?: Date;
}

export class WorldStore {
  private worlds = new Map<string, WorldMeta>();
  private files = new Map<string, FilesInfo>();
  private loaded: Promise<void> | null = null;
  private q = new SerialQueue();

  constructor(
    readonly root: string,
    private log: (msg: string) => void = () => undefined,
  ) {}

  // ───────────── paths (only ever built from ids that passed isValidId) ─────────────
  worldDir(id: string): string {
    if (!isValidId(id)) throw new WorldError('BAD_REQUEST', 'invalid world id');
    return join(this.root, id);
  }
  worldVwg(id: string): string {
    return join(this.worldDir(id), WORLD_VWG);
  }
  worldIndex(id: string): string {
    return join(this.worldDir(id), WORLD_INDEX);
  }
  detailVwg(worldId: string, detailId: string): string {
    if (!isValidId(detailId)) throw new WorldError('BAD_REQUEST', 'invalid detail id');
    return join(this.worldDir(worldId), DETAILS_DIR, `${detailId}.vwg`);
  }
  private detailJson(worldId: string, detailId: string): string {
    return join(this.worldDir(worldId), DETAILS_DIR, `${detailId}.json`);
  }

  // ───────────── loading ─────────────
  /** Scan the library once. Corrupt/incomplete entries are skipped (logged), never thrown. */
  init(): Promise<void> {
    this.loaded ??= this.q.run(() => this.scan());
    return this.loaded;
  }

  /** Resolves once every queued mutation has finished (used to drain before quitting). */
  idle(): Promise<void> {
    return this.q.run(async () => undefined);
  }

  private async writeMeta(dir: string, w: WorldMeta): Promise<void> {
    const body = { ...w, formatVersion: 1, details: [], files: this.files.get(w.id) ?? {} };
    await writeFileAtomic(join(dir, META_FILE), JSON.stringify(body, null, 1));
  }

  private seen = new Map<string, string>(); // id -> "metaMtime:detailsMtime" of what is loaded
  private firstScan = true;

  private async stamp(id: string): Promise<string> {
    const m = await stat(join(this.root, id, META_FILE)).then((x) => x.mtimeMs, () => -1);
    const d = await stat(join(this.root, id, DETAILS_DIR)).then((x) => x.mtimeMs, () => -1);
    return `${m}:${d}`;
  }

  /**
   * (Re)scan the library directory. Incremental: a world whose meta.json and details/ mtimes are unchanged is kept;
   * new/changed ones are loaded, vanished ones dropped. Corrupt entries are skipped with a log, never thrown.
   */
  private async scan(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    let names: string[] = [];
    try {
      names = await readdir(this.root);
    } catch (e) {
      this.log(`[worlds] cannot read ${this.root}: ${(e as Error).message}`);
    }
    const present = new Set<string>();
    for (const n of names) {
      const full = join(this.root, n);
      if (n === DAMAGED_DIR) {
        if (this.firstScan) await this.sweepDamaged();
        continue;
      }
      if (n.startsWith('.tmp-')) {
        if (this.firstScan) await rm(full, { recursive: true, force: true }).catch(() => undefined); // interrupted save
        continue;
      }
      if (!isValidId(n)) {
        if (this.firstScan) this.log(`[worlds] skipping unexpected entry ${n}`);
        continue;
      }
      present.add(n);
      const st = await this.stamp(n);
      if (this.worlds.has(n) && this.seen.get(n) === st) continue;
      try {
        const { meta, files } = await this.loadWorld(n);
        this.worlds.set(n, meta);
        this.files.set(n, files);
      } catch (e) {
        this.log(`[worlds] world ${n} is damaged (${(e as Error).message}); moving it to ${DAMAGED_DIR}/`);
        this.worlds.delete(n);
        this.files.delete(n);
        await this.quarantine(n);
        this.seen.delete(n);
        continue;
      }
      this.seen.set(n, st);
    }
    for (const id of [...this.worlds.keys()]) {
      if (!present.has(id)) {
        this.worlds.delete(id);
        this.files.delete(id);
        this.seen.delete(id);
      }
    }
    for (const id of [...this.seen.keys()]) if (!present.has(id)) this.seen.delete(id);
    this.firstScan = false;
  }

  /** Move an unusable world out of the library (kept on disk for manual recovery; swept after 30 days). */
  private async quarantine(id: string): Promise<void> {
    try {
      const dst = join(this.root, DAMAGED_DIR);
      await mkdir(dst, { recursive: true });
      let target = join(dst, id);
      if (existsSync(target)) target = join(dst, `${id}.${Date.now()}`);
      await rename(join(this.root, id), target);
      await fsyncDir(this.root);
    } catch (e) {
      this.log(`[worlds] could not quarantine ${id}: ${(e as Error).message}`);
    }
  }

  private async sweepDamaged(): Promise<void> {
    const dir = join(this.root, DAMAGED_DIR);
    try {
      for (const n of await readdir(dir)) {
        const st = await stat(join(dir, n)).catch(() => null);
        if (st && Date.now() - st.mtimeMs > DAMAGED_TTL_MS) await rm(join(dir, n), { recursive: true, force: true });
      }
    } catch {
      /* none */
    }
  }

  /** Remove leftovers of interrupted writes older than 1 h (younger ones may belong to a write in progress). */
  private async sweepOrphans(dir: string, match: (name: string) => boolean): Promise<void> {
    try {
      for (const n of await readdir(dir)) {
        if (!match(n)) continue;
        const st = await stat(join(dir, n)).catch(() => null);
        if (st && st.isFile() && Date.now() - st.mtimeMs > ORPHAN_AGE_MS) await rm(join(dir, n), { force: true });
      }
    } catch {
      /* dir missing */
    }
  }

  private async loadWorld(id: string): Promise<{ meta: WorldMeta; files: FilesInfo }> {
    const dir = this.worldDir(id);
    await this.sweepOrphans(dir, (n) => n.startsWith(`${META_FILE}.tmp-`));
    const raw = await readJsonFile<unknown>(join(dir, META_FILE));
    const n = normaliseMeta(raw, id);
    if (!n) throw new Error('meta.json invalid');
    const vwgSize = await fileSize(join(dir, WORLD_VWG));
    if (vwgSize === null) throw new Error('world.vwg missing');
    if (vwgSize === 0) throw new Error('world.vwg is empty');
    if (n.files.vwgBytes !== undefined && n.files.vwgBytes !== vwgSize) {
      throw new Error(`world.vwg is ${vwgSize} bytes, expected ${n.files.vwgBytes} (truncated?)`);
    }
    const idxSize = await fileSize(join(dir, WORLD_INDEX));
    n.meta.hasBuildingIndex = idxSize !== null && idxSize > 0 && (n.files.indexBytes === undefined || n.files.indexBytes === idxSize);
    if (idxSize !== null && !n.meta.hasBuildingIndex) this.log(`[worlds] ignoring damaged building index of ${id}`);
    n.meta.details = await this.loadDetails(id);
    return n;
  }

  private async loadDetails(worldId: string): Promise<DetailRecord[]> {
    const dir = join(this.worldDir(worldId), DETAILS_DIR);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: DetailRecord[] = [];
    const jsons = new Set(names.filter((n) => n.endsWith('.json')));
    await this.sweepOrphans(dir, (n) => n.endsWith('.vwg') && !jsons.has(`${n.slice(0, -4)}.json`));
    for (const n of names) {
      if (!n.endsWith('.json') || n.includes('.tmp-')) {
        if (n.includes('.tmp-')) await rm(join(dir, n), { force: true }).catch(() => undefined);
        continue;
      }
      const id = n.slice(0, -5);
      if (!isValidId(id)) continue;
      try {
        const rec = normaliseDetail(await readJsonFile<unknown>(join(dir, n)), worldId, id);
        if (!rec) throw new Error('record invalid');
        const sz = await fileSize(join(dir, `${id}.vwg`));
        if (sz === null) throw new Error('vwg missing');
        if (sz === 0) throw new Error('vwg is empty');
        if (rec.vwgBytes !== undefined && rec.vwgBytes !== sz) throw new Error(`vwg is ${sz} bytes, expected ${rec.vwgBytes} (truncated?)`);
        out.push(rec.record);
      } catch (e) {
        this.log(`[worlds] skipping corrupt detail ${worldId}/${id}: ${(e as Error).message}`);
      }
    }
    return sortDetails(out);
  }

  // ───────────── queries ─────────────
  async list(): Promise<WorldMeta[]> {
    await this.init();
    return this.q.run(async () => {
      await this.scan(); // picks up out-of-band worlds, drops vanished ones; unchanged ones are not re-read
      return [...this.worlds.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(clone);
    });
  }

  async get(id: string): Promise<WorldMeta> {
    await this.init();
    return this.q.run(async () => clone(this.require(id)));
  }

  private require(id: unknown): WorldMeta {
    if (!isValidId(id)) throw new WorldError('BAD_REQUEST', 'invalid world id');
    const w = this.worlds.get(id);
    if (!w) throw new WorldError('WORLD_NOT_FOUND', 'world not found');
    return w;
  }

  /** Resolve a world for opening: re-checks that its files still exist (drops it from the library if not). */
  async open(id: string): Promise<SavedWorld> {
    await this.init();
    return this.q.run(async () => {
      if (isValidId(id) && !this.worlds.has(id)) await this.scan(); // may have appeared out-of-band
      const w = this.require(id);
      const vwgPath = this.worldVwg(id);
      const sz = await fileSize(vwgPath);
      const want = this.files.get(id)?.vwgBytes;
      if (!sz || (want !== undefined && sz !== want)) {
        this.worlds.delete(id);
        this.log(`[worlds] world ${id} lost its world.vwg; removed from the library view`);
        throw new WorldError('WORLD_NOT_FOUND', 'world files are missing');
      }
      const idx = this.worldIndex(id);
      const hasIdx = (await fileSize(idx)) !== null;
      w.hasBuildingIndex = hasIdx;
      return { meta: clone(w), vwgPath, ...(hasIdx ? { buildingIndexPath: idx } : {}) };
    });
  }

  async listDetails(worldId: string): Promise<DetailRecord[]> {
    await this.init();
    return this.q.run(async () => this.require(worldId).details.map(clone));
  }

  /** Trusted .vwg path of a saved detail (checks it exists in the library and on disk). */
  async openDetail(worldId: string, detailId: string): Promise<{ record: DetailRecord; vwgPath: string }> {
    await this.init();
    return this.q.run(async () => {
      const w = this.require(worldId);
      if (!isValidId(detailId)) throw new WorldError('BAD_REQUEST', 'invalid detail id');
      const rec = w.details.find((d) => d.id === detailId);
      if (!rec) throw new WorldError('WORLD_NOT_FOUND', 'detail not found');
      const vwgPath = this.detailVwg(worldId, detailId);
      if (!(await fileSize(vwgPath))) {
        w.details = w.details.filter((d) => d.id !== detailId);
        throw new WorldError('WORLD_NOT_FOUND', 'detail files are missing');
      }
      return { record: clone(rec), vwgPath };
    });
  }

  // ───────────── mutations ─────────────
  /** Auto-save of a successful generate: copies the temp .vwg (+ building index) into a new world. */
  async saveWorld(inp: SaveWorldInput): Promise<SavedWorld> {
    await this.init();
    return this.q.run(async () => {
      const id = randomUUID();
      const tmp = join(this.root, `.tmp-${id}`);
      const final = join(this.root, id);
      const now = (inp.now ?? new Date()).toISOString();
      try {
        await mkdir(tmp, { recursive: true });
        await copyFileAtomic(inp.vwgPath, join(tmp, WORLD_VWG));
        let hasIdx = false;
        if (inp.buildingIndexPath && (await fileSize(inp.buildingIndexPath)) !== null) {
          await copyFileAtomic(inp.buildingIndexPath, join(tmp, WORLD_INDEX));
          hasIdx = true;
        }
        const stats = normaliseStats(inp.stats);
        const meta: WorldMeta = {
          formatVersion: 1,
          id,
          name: defaultWorldName(inp.params.bbox, inp.now, inp.sourceLabel ?? (inp.params.dataSource?.kind === 'pbf' ? inp.params.dataSource.regionId : 'Overpass')),
          createdAt: now,
          updatedAt: now,
          bbox: { ...inp.params.bbox },
          voxelSize: inp.params.voxelSize,
          params: sanitizeParams(inp.params),
          stats,
          sizeBytes: 0,
          hasBuildingIndex: hasIdx,
          details: [],
          ...(inp.sourceInfo ? { sourceInfo: inp.sourceInfo } : {}),
        };
        meta.sizeBytes = (await dirSize(tmp)) + 1024;
        const files: FilesInfo = { vwgBytes: (await fileSize(join(tmp, WORLD_VWG))) ?? 0 };
        if (hasIdx) files.indexBytes = (await fileSize(join(tmp, WORLD_INDEX))) ?? 0;
        if (!files.vwgBytes) throw new WorldError('INTERNAL', 'the generated .vwg is empty');
        this.files.set(id, files);
        await this.writeMeta(tmp, meta);
        await fsyncDir(tmp);
        await rename(tmp, final);
        await fsyncDir(this.root);
        this.worlds.set(id, meta);
        return {
          meta: clone(meta),
          vwgPath: join(final, WORLD_VWG),
          ...(hasIdx ? { buildingIndexPath: join(final, WORLD_INDEX) } : {}),
        };
      } catch (e) {
        this.files.delete(id);
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
        throw e;
      }
    });
  }

  /** Auto-save of a successful detail into `worldId`. Same building + same options/spec hash overwrites. */
  async saveDetail(inp: SaveDetailInput): Promise<{ world: WorldMeta; record: DetailRecord; vwgPath: string }> {
    await this.init();
    return this.q.run(async () => {
      const w = this.require(inp.worldId);
      const id = detailIdFor(inp.params);
      const dir = join(this.worldDir(w.id), DETAILS_DIR);
      await mkdir(dir, { recursive: true });
      const vwgDst = join(dir, `${id}.vwg`);
      const vwgSize = await fileSize(inp.vwgPath);
      if (!vwgSize) throw new WorldError('INTERNAL', 'detail .vwg is missing or empty');
      await copyFileAtomic(inp.vwgPath, vwgDst); // rename over an existing file is atomic
      const copied = await fileSize(vwgDst);
      if (copied !== vwgSize) throw new WorldError('INTERNAL', 'detail .vwg copy is incomplete');
      const record: DetailRecord = {
        id,
        worldId: w.id,
        buildingId: inp.params.ref.buildingId,
        ...(inp.buildingName ? { buildingName: inp.buildingName } : {}),
        createdAt: (inp.now ?? new Date()).toISOString(),
        voxelSize: inp.params.voxelSize,
        interior: !!inp.params.interior?.enabled,
        ...(inp.params.facade ? { facade: { edge: inp.params.facade.edge } } : {}),
        stats: normaliseDetailStats(inp.stats),
        sizeBytes: vwgSize,
      };
      await writeFileAtomic(this.detailJson(w.id, id), JSON.stringify({ ...record, vwgBytes: vwgSize }, null, 1)); // commit marker
      w.details = sortDetails([record, ...w.details.filter((d) => d.id !== id)]);
      w.updatedAt = record.createdAt;
      w.sizeBytes = await dirSize(this.worldDir(w.id));
      await this.writeMeta(this.worldDir(w.id), w);
      return { world: clone(w), record: clone(record), vwgPath: vwgDst };
    });
  }

  async rename(id: string, name: string): Promise<WorldMeta> {
    await this.init();
    return this.q.run(async () => {
      const w = this.require(id);
      const n = cleanWorldName(name);
      const next: WorldMeta = { ...w, name: n, updatedAt: new Date().toISOString() };
      await this.writeMeta(this.worldDir(id), next);
      Object.assign(w, next);
      return clone(w);
    });
  }

  async deleteWorld(id: string): Promise<void> {
    await this.init();
    return this.q.run(async () => {
      this.require(id);
      const dir = this.worldDir(id);
      // Move out of the way first (atomic), then delete: a crash mid-delete leaves only a .tmp- dir to sweep.
      const gone = join(this.root, `.tmp-del-${id}`);
      await rename(dir, gone);
      await fsyncDir(this.root);
      this.worlds.delete(id);
      this.files.delete(id);
      await rm(gone, { recursive: true, force: true }).catch((e) => this.log(`[worlds] cleanup of ${id} failed: ${e}`));
    });
  }

  async deleteDetail(worldId: string, detailId: string): Promise<WorldMeta> {
    await this.init();
    return this.q.run(async () => {
      const w = this.require(worldId);
      if (!isValidId(detailId)) throw new WorldError('BAD_REQUEST', 'invalid detail id');
      if (!w.details.some((d) => d.id === detailId)) throw new WorldError('WORLD_NOT_FOUND', 'detail not found');
      await rm(this.detailJson(worldId, detailId), { force: true }); // record first: without it the vwg is an orphan
      await rm(this.detailVwg(worldId, detailId), { force: true });
      w.details = w.details.filter((d) => d.id !== detailId);
      w.sizeBytes = await dirSize(this.worldDir(worldId));
      w.updatedAt = new Date().toISOString();
      await this.writeMeta(this.worldDir(worldId), w);
      return clone(w);
    });
  }

  /** Building display name from a world's index (best effort; used for DetailRecord.buildingName). */
  async buildingName(worldId: string, buildingId: string): Promise<string | undefined> {
    try {
      const idx = await readJsonFile<{ buildings?: Array<{ id?: string; name?: string }> }>(this.worldIndex(worldId));
      const b = idx.buildings?.find((x) => x.id === buildingId);
      return typeof b?.name === 'string' && b.name ? b.name.slice(0, 120) : undefined;
    } catch {
      return undefined;
    }
  }

  has(id: string): boolean {
    return isValidId(id) && this.worlds.has(id);
  }
}

const sortDetails = (d: DetailRecord[]): DetailRecord[] => [...d].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
