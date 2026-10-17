import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, rmdir, stat, statfs } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import type { BBox, DataSource, GeodataEntry, GeodataProgress, GeodataRegion } from '../shared/contract';
import { fileSize, fsyncDir, isInside, isInsideReal, readJsonFile, sleep, writeFileAtomic } from './fsutil';
import { multiPolyAreaKm2, multiPolyCoversBBox, multiPolyIntersectsBBox, type Poly } from './geometry';
import { isRegionId } from './validate';

/**
 * Geofabrik extracts: catalogue (index-v1.json, cached), resumable verified downloads, local inventory.
 * Electron-free: ipc.ts passes `<userData>/geodata`. Network policy is injectable for tests; the default only
 * ever talks to https://download.geofabrik.de (every redirect hop is re-validated).
 *
 *   <dir>/index-v1.json (+ index-v1.meta.json: etag, last-modified, fetchedAt)
 *   <dir>/sizes.json                           HEAD-derived download sizes (best effort)
 *   <dir>/<regionId>/<file>.osm.pbf            regionId may contain '/', e.g. "us/alabama"
 *   <dir>/<regionId>/<file>.json               sidecar (GeodataEntry)
 *   <dir>/<regionId>/<file>.osm.pbf.part       + .part.json (resume validators)
 */

export const GEOFABRIK_INDEX_URL = 'https://download.geofabrik.de/index-v1.json';
export const MAX_CONCURRENT_DOWNLOADS = 2;
const CATALOGUE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const INDEX_MAX_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_RETRIES = 4;
const SIZE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export class GeodataError extends Error {
  constructor(
    public code: 'DOWNLOAD_FAILED' | 'CANCELLED' | 'BAD_REQUEST',
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** Server did not answer the request headers in time. */
export class NetTimeout extends GeodataError {
  constructor(message: string) {
    super('DOWNLOAD_FAILED', message);
  }
}

class Retryable extends Error {
  constructor(
    message: string,
    public resetPart = false,
  ) {
    super(message);
  }
}

export const defaultUrlPolicy = (u: URL): boolean =>
  u.protocol === 'https:' && u.hostname === 'download.geofabrik.de' && !u.username && !u.password && (u.port === '' || u.port === '443');

interface CatalogRegion {
  region: GeodataRegion;
  polys: Poly[];
  area: number;
}

/** Parse the Geofabrik index (GeoJSON FeatureCollection). Entries with unusable ids/urls are dropped. */
export function parseCatalogue(json: unknown, urlPolicy: (u: URL) => boolean = defaultUrlPolicy): CatalogRegion[] {
  const fc = json as { features?: unknown };
  if (!fc || !Array.isArray(fc.features)) throw new Error('not a Geofabrik index');
  const out: CatalogRegion[] = [];
  for (const f of fc.features as Array<Record<string, any>>) {
    const p = f?.properties;
    const pbf = p?.urls?.pbf;
    if (!p || !isRegionId(p.id) || typeof pbf !== 'string' || typeof p.name !== 'string') continue;
    let u: URL;
    try {
      u = new URL(pbf);
    } catch {
      continue;
    }
    if (!urlPolicy(u) || !u.pathname.endsWith('.osm.pbf')) continue;
    const g = f.geometry;
    let polys: Poly[] = [];
    if (g?.type === 'MultiPolygon') polys = g.coordinates as Poly[];
    else if (g?.type === 'Polygon') polys = [g.coordinates as Poly];
    out.push({
      region: { id: p.id, name: p.name, ...(typeof p.parent === 'string' ? { parent: p.parent } : {}), pbfUrl: pbf },
      polys,
      area: polys.length ? multiPolyAreaKm2(polys) : Infinity,
    });
  }
  return out;
}

/**
 * Regions fully covering the bbox (smallest area first), then regions that merely intersect it (smallest first,
 * at most MAX_EXTRA_INTERSECTING) so a border bbox also sees the neighbouring countries.
 */
const MAX_EXTRA_INTERSECTING = 12;
export function suggestRegions(cat: CatalogRegion[], bbox: BBox): GeodataRegion[] {
  const order = (a: CatalogRegion, b: CatalogRegion): number => a.area - b.area || a.region.id.localeCompare(b.region.id);
  const covering = cat.filter((c) => c.polys.length && multiPolyCoversBBox(c.polys, bbox)).sort(order);
  const coverIds = new Set(covering.map((c) => c.region.id));
  const touching = cat
    .filter((c) => c.polys.length && !coverIds.has(c.region.id) && multiPolyIntersectsBBox(c.polys, bbox))
    .sort(order)
    .slice(0, MAX_EXTRA_INTERSECTING);
  return [...covering.map((c) => ({ ...c.region, covers: true })), ...touching.map((c) => ({ ...c.region, covers: false }))];
}

/** First 32-hex token of a Geofabrik .md5 file ("<md5>  <name>"). */
export function parseMd5(text: string): string | null {
  const m = /^\s*([0-9a-fA-F]{32})(?:\s|$)/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

export interface GeodataOptions {
  dir: string;
  version: string;
  log?: (m: string) => void;
  onProgress?: (e: GeodataProgress) => void;
  fetchImpl?: typeof fetch;
  urlPolicy?: (u: URL) => boolean;
  indexUrl?: string;
  /** safety margin kept free on top of the file size (default 64 MiB) */
  freeMarginBytes?: number;
  /** abort when no bytes arrive for this long (default 30 s) */
  stallMs?: number;
  retryDelayMs?: number;
  /** cap for the catalogue body (default 64 MiB) */
  indexMaxBytes?: number;
  statfsFn?: (dir: string) => Promise<{ bavail: number; bsize: number }>;
}

interface Job {
  regionId: string;
  ac: AbortController;
  cancelled: boolean;
  stalled: boolean;
  /** bytes still to be written by this job (for the shared free-space check) */
  remaining: number;
  promise: Promise<GeodataEntry>;
}

interface PartMeta {
  url: string;
  etag?: string;
  lastModified?: string;
  total?: number;
}

export class GeodataManager {
  private catalogue: CatalogRegion[] | null = null;
  private jobs = new Map<string, Job>();
  private o: Required<Omit<GeodataOptions, 'log' | 'onProgress' | 'fetchImpl' | 'statfsFn'>> &
    Pick<GeodataOptions, 'log' | 'onProgress' | 'fetchImpl' | 'statfsFn'>;
  private sizes: Record<string, { size: number; at: number }> | null = null;

  constructor(opts: GeodataOptions) {
    this.o = {
      urlPolicy: defaultUrlPolicy,
      indexUrl: GEOFABRIK_INDEX_URL,
      freeMarginBytes: 64 * 1024 * 1024,
      stallMs: 30_000,
      retryDelayMs: 1000,
      indexMaxBytes: INDEX_MAX_BYTES,
      ...opts,
    };
  }

  get dir(): string {
    return this.o.dir;
  }
  private log(m: string): void {
    this.o.log?.(`[geodata] ${m}`);
  }
  private emit(e: GeodataProgress): void {
    try {
      this.o.onProgress?.(e);
    } catch {
      /* listener errors must not break a download */
    }
  }

  // ───────────────────────── HTTP (policy-checked, manual redirects) ─────────────────────────
  async request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal; headerTimeoutMs?: number } = {},
  ): Promise<{ res: Response; finalUrl: string }> {
    const f = this.o.fetchImpl ?? fetch;
    const headerMs = init.headerTimeoutMs ?? this.o.stallMs;
    let cur = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let u: URL;
      try {
        u = new URL(cur);
      } catch {
        throw new GeodataError('DOWNLOAD_FAILED', 'invalid URL');
      }
      if (!this.o.urlPolicy(u)) throw new GeodataError('DOWNLOAD_FAILED', `refusing to contact ${u.hostname} (only download.geofabrik.de over https is allowed)`);
      // One controller per hop: caller abort propagates (also to the body later), header timeout only guards the wait for headers.
      const ac = new AbortController();
      const onAbort = (): void => ac.abort();
      if (init.signal?.aborted) ac.abort();
      else init.signal?.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, headerMs);
      let res: Response;
      try {
        res = await f(u.href, {
          method: init.method ?? 'GET',
          redirect: 'manual',
          signal: ac.signal,
          headers: { 'User-Agent': `VoxelWorlds/${this.o.version}`, Accept: '*/*', ...init.headers },
        });
      } catch (e) {
        init.signal?.removeEventListener('abort', onAbort);
        if (timedOut && !init.signal?.aborted) throw new NetTimeout(`${u.hostname} did not respond within ${Math.round(headerMs / 1000)} s`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        init.signal?.removeEventListener('abort', onAbort);
        const loc = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!loc) throw new GeodataError('DOWNLOAD_FAILED', `redirect without Location (HTTP ${res.status})`);
        cur = new URL(loc, u).href;
        continue;
      }
      return { res, finalUrl: u.href };
    }
    throw new GeodataError('DOWNLOAD_FAILED', 'too many redirects');
  }

  /** Read a whole body with a byte cap and a stall timeout (no data for `stallMs` => abort), honouring `signal`. */
  async readCapped(res: Response, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    if (!res.body) return Buffer.alloc(0);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      throw new GeodataError('DOWNLOAD_FAILED', `response too large (${declared} bytes)`);
    }
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    let stalled = false;
    let timer: NodeJS.Timeout | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        void reader.cancel().catch(() => undefined);
      }, this.o.stallMs);
    };
    const onAbort = (): void => void reader.cancel().catch(() => undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
    arm();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (stalled) throw new NetTimeout('connection stalled while reading the response');
        if (signal?.aborted) throw new GeodataError('CANCELLED', 'cancelled');
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new GeodataError('DOWNLOAD_FAILED', `response larger than ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
        arm();
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    return Buffer.concat(chunks);
  }

  private async withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      return await fn(ac.signal);
    } finally {
      clearTimeout(t);
    }
  }

  // ───────────────────────── catalogue ─────────────────────────
  private get indexFile(): string {
    return join(this.o.dir, 'index-v1.json');
  }
  private get indexMetaFile(): string {
    return join(this.o.dir, 'index-v1.meta.json');
  }

  private async loadCatalogue(refresh: boolean): Promise<CatalogRegion[]> {
    if (this.catalogue && !refresh) return this.catalogue;
    await mkdir(this.o.dir, { recursive: true });
    let cached: CatalogRegion[] | null = null;
    let meta: { etag?: string; lastModified?: string; fetchedAt?: number } = {};
    try {
      cached = parseCatalogue(await readJsonFile(this.indexFile), this.o.urlPolicy);
      meta = await readJsonFile<typeof meta>(this.indexMetaFile).catch(() => ({}));
    } catch {
      cached = null;
    }
    const stale = !cached || refresh || Date.now() - (meta.fetchedAt ?? 0) > CATALOGUE_MAX_AGE_MS;
    if (cached && !stale) return (this.catalogue = cached);
    try {
      const headers: Record<string, string> = {};
      if (cached && meta.etag) headers['If-None-Match'] = meta.etag;
      else if (cached && meta.lastModified) headers['If-Modified-Since'] = meta.lastModified;
      const ac = new AbortController();
      const overall = setTimeout(() => ac.abort(), 120_000);
      let buf: Buffer;
      let res: Response;
      try {
        ({ res } = await this.request(this.o.indexUrl, { headers, signal: ac.signal, headerTimeoutMs: 20_000 }));
        if (res.status === 304 && cached) {
          await res.body?.cancel().catch(() => undefined);
          await writeFileAtomic(this.indexMetaFile, JSON.stringify({ ...meta, fetchedAt: Date.now() }));
          return (this.catalogue = cached);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = await this.readCapped(res, this.o.indexMaxBytes, ac.signal);
      } finally {
        clearTimeout(overall);
      }
      const parsed = parseCatalogue(JSON.parse(buf.toString('utf8')), this.o.urlPolicy);
      if (parsed.length < 1) throw new Error('catalogue is empty');
      await writeFileAtomic(this.indexFile, buf);
      await writeFileAtomic(
        this.indexMetaFile,
        JSON.stringify({ etag: res.headers.get('etag') ?? undefined, lastModified: res.headers.get('last-modified') ?? undefined, fetchedAt: Date.now() }),
      );
      return (this.catalogue = parsed);
    } catch (e) {
      if (cached) {
        this.log(`catalogue refresh failed (${(e as Error).message}); using cached copy`);
        this.catalogue = cached;
        if (refresh) {
          // An explicit refresh must not pretend to have succeeded; the message carries the cache date for the UI.
          const when = meta.fetchedAt ? new Date(meta.fetchedAt).toISOString().slice(0, 10) : 'an earlier session';
          throw new GeodataError('DOWNLOAD_FAILED', `cannot reach download.geofabrik.de; showing saved list from ${when}`);
        }
        return cached;
      }
      throw new GeodataError('DOWNLOAD_FAILED', `cannot load the Geofabrik region list (offline and nothing cached): ${(e as Error).message}`);
    }
  }

  async listRegions(opts?: { refresh?: boolean }): Promise<GeodataRegion[]> {
    const cat = await this.loadCatalogue(!!opts?.refresh);
    const have = new Map((await this.listEntries()).map((e) => [e.regionId, e]));
    const sizes = await this.loadSizes();
    // Downloaded regions report their local file size; known-but-stale remote sizes are refreshed in the background.
    const now = Date.now();
    const stale = cat
      .map((c) => c.region)
      .filter((r) => !have.has(r.id) && sizes[r.id] && now - sizes[r.id].at >= SIZE_MAX_AGE_MS);
    this.refreshSizesInBackground(stale, sizes);
    return cat.map(({ region }) => {
      const e = have.get(region.id);
      const sizeBytes = e?.sizeBytes ?? sizes[region.id]?.size;
      return { ...region, ...(sizeBytes ? { sizeBytes } : {}), downloaded: !!e };
    });
  }

  /** HEAD one region's pbf for its Content-Length (2 attempts); records it in sizes.json memory. */
  private async headSize(r: GeodataRegion, sizes: Record<string, { size: number; at: number }>): Promise<void> {
    for (let i = 0; i < 2; i++) {
      try {
        const { res } = await this.withTimeout(4000, (signal) => this.request(r.pbfUrl, { method: 'HEAD', signal, headerTimeoutMs: 4000 }));
        const n = Number(res.headers.get('content-length'));
        if (res.ok && Number.isFinite(n) && n > 0) {
          sizes[r.id] = { size: n, at: Date.now() };
          return;
        }
      } catch {
        /* retry once */
      }
    }
  }

  private bgSizes = false;
  /** Fire-and-forget: refresh stale/missing sizes of up to 8 regions without delaying the caller. */
  private refreshSizesInBackground(regions: GeodataRegion[], sizes: Record<string, { size: number; at: number }>): void {
    if (this.bgSizes || !regions.length) return;
    this.bgSizes = true;
    void Promise.allSettled(regions.slice(0, 8).map((r) => this.headSize(r, sizes)))
      .then(() => writeFileAtomic(join(this.o.dir, 'sizes.json'), JSON.stringify(sizes)))
      .catch(() => undefined)
      .finally(() => {
        this.bgSizes = false;
      });
  }

  /** Covering regions, smallest first (see suggestRegions). Fills missing sizes with quick HEAD requests (<= 4 s total). */
  async suggest(bbox: BBox): Promise<GeodataRegion[]> {
    const cat = await this.loadCatalogue(false);
    const picked = suggestRegions(cat, bbox);
    const have = new Map((await this.listEntries()).map((e) => [e.regionId, e]));
    const sizes = await this.loadSizes();
    const now = Date.now();
    const missing = picked.filter((r) => !have.has(r.id) && !(sizes[r.id] && now - sizes[r.id].at < SIZE_MAX_AGE_MS)).slice(0, 8);
    if (missing.length) {
      await Promise.race([
        Promise.allSettled(
          missing.map((r) => this.headSize(r, sizes)),
        ),
        new Promise((r) => setTimeout(r, 4500)),
      ]);
      await writeFileAtomic(join(this.o.dir, 'sizes.json'), JSON.stringify(sizes)).catch(() => undefined);
    }
    return picked.map((r) => {
      const e = have.get(r.id);
      const sizeBytes = e?.sizeBytes ?? sizes[r.id]?.size;
      return { ...r, ...(sizeBytes ? { sizeBytes } : {}), downloaded: !!e };
    });
  }

  /** sizes.json: { [regionId]: { size, at } }. Entries with bad ids/values are dropped; legacy plain numbers count as stale. */
  private async loadSizes(): Promise<Record<string, { size: number; at: number }>> {
    if (this.sizes) return this.sizes;
    const out: Record<string, { size: number; at: number }> = {};
    try {
      const raw = await readJsonFile<Record<string, unknown>>(join(this.o.dir, 'sizes.json'));
      if (raw && typeof raw === 'object') {
        for (const [id, v] of Object.entries(raw)) {
          if (!isRegionId(id)) continue;
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[id] = { size: v, at: 0 };
          else if (v && typeof v === 'object') {
            const { size, at } = v as { size?: unknown; at?: unknown };
            if (typeof size === 'number' && Number.isFinite(size) && size > 0) out[id] = { size, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 };
          }
        }
      }
    } catch {
      /* missing or corrupt: start empty */
    }
    return (this.sizes = out);
  }

  // ───────────────────────── local inventory ─────────────────────────
  /** Walk <dir> for *.osm.pbf; regionId = relative directory ("us/alabama"). Inconsistent files are skipped with a log. */
  async listEntries(): Promise<GeodataEntry[]> {
    const out: GeodataEntry[] = [];
    const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
      let names;
      try {
        names = await readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      const pbfs = names.filter((n) => n.isFile() && n.name.endsWith('.osm.pbf'));
      if (rel && pbfs.length && isRegionId(rel)) {
        const cands: GeodataEntry[] = [];
        for (const f of pbfs) {
          const e = await this.readEntry(rel, abs, f.name);
          if (e) cands.push(e);
        }
        cands.sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
        if (cands[0]) out.push(cands[0]);
      }
      if (depth >= 4) return;
      for (const d of names) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        await walk(join(abs, d.name), rel ? posix.join(rel, d.name) : d.name, depth + 1);
      }
    };
    await walk(this.o.dir, '', 0);
    return out.sort((a, b) => a.regionId.localeCompare(b.regionId));
  }

  private async readEntry(regionId: string, abs: string, fileName: string): Promise<GeodataEntry | null> {
    const pbfPath = join(abs, fileName);
    const base = fileName.slice(0, -'.osm.pbf'.length);
    try {
      const st = await stat(pbfPath);
      if (!st.isFile() || st.size === 0) return null;
      let side: Partial<GeodataEntry> | null = null;
      try {
        side = await readJsonFile<Partial<GeodataEntry>>(join(abs, `${base}.json`));
      } catch {
        side = null;
      }
      if (side && typeof side.sizeBytes === 'number' && side.sizeBytes !== st.size) {
        this.log(`skipping ${pbfPath}: size ${st.size} differs from sidecar ${side.sizeBytes} (interrupted write?)`);
        return null;
      }
      return {
        regionId,
        name: typeof side?.name === 'string' ? side.name : (this.catalogue?.find((c) => c.region.id === regionId)?.region.name ?? regionId),
        pbfPath,
        sizeBytes: st.size,
        downloadedAt: typeof side?.downloadedAt === 'string' ? side.downloadedAt : st.mtime.toISOString(),
        ...(typeof side?.sourceDate === 'string' ? { sourceDate: side.sourceDate } : {}),
        verified: side?.verified === true,
      };
    } catch {
      return null;
    }
  }

  async entryFor(regionId: string): Promise<GeodataEntry | null> {
    if (!isRegionId(regionId)) return null;
    const dir = join(this.o.dir, ...regionId.split('/'));
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return null;
    }
    const cands: GeodataEntry[] = [];
    for (const n of names.filter((x) => x.endsWith('.osm.pbf'))) {
      const e = await this.readEntry(regionId, dir, n);
      if (e) cands.push(e);
    }
    cands.sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
    return cands[0] ?? null;
  }

  /**
   * Turn a renderer-supplied DataSource into what python receives. For 'pbf' the path ALWAYS comes from our own
   * inventory (any renderer-supplied pbfPath is discarded); unknown/missing => BAD_REQUEST 'region not downloaded'.
   */
  async resolveDataSource(ds: DataSource | undefined): Promise<DataSource> {
    if (!ds || ds.kind === 'overpass') return { kind: 'overpass' };
    if (ds.kind !== 'pbf' || !isRegionId(ds.regionId)) throw new GeodataError('BAD_REQUEST', 'invalid dataSource');
    const e = await this.entryFor(ds.regionId);
    if (!e || !(await isInsideReal(this.o.dir, e.pbfPath)) || (await fileSize(e.pbfPath)) === null) {
      throw new GeodataError('BAD_REQUEST', 'region not downloaded');
    }
    return { kind: 'pbf', regionId: ds.regionId, pbfPath: e.pbfPath };
  }

  async delete(regionId: string): Promise<void> {
    if (!isRegionId(regionId)) throw new GeodataError('BAD_REQUEST', 'invalid regionId');
    const job = this.jobs.get(regionId);
    if (job) {
      this.cancel(regionId);
      await job.promise.catch(() => undefined);
    }
    const dir = join(this.o.dir, ...regionId.split('/'));
    if (!isInside(this.o.dir, dir)) throw new GeodataError('BAD_REQUEST', 'invalid regionId');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    // Only files of this region; child regions ("us" vs "us/alabama") live in sub-directories and are left alone.
    for (const n of names) {
      if (/\.osm\.pbf(\.part|\.part\.json|\.md5|\.vwidx.*)?$/.test(n) || /\.json$/.test(n) || n.includes('.tmp-')) {
        const full = join(dir, n);
        const st = await stat(full).catch(() => null);
        if (st?.isFile()) await rm(full, { force: true });
      }
    }
    // prune now-empty directories up to (not including) the geodata root; rmdir fails on non-empty ones
    for (let d = dir; d !== this.o.dir && isInside(this.o.dir, d); d = dirname(d)) {
      try {
        await rmdir(d);
      } catch {
        break;
      }
    }
  }

  // ───────────────────────── downloads ─────────────────────────
  cancel(regionId?: string): void {
    for (const [id, j] of this.jobs) {
      if (regionId === undefined || regionId === id) {
        j.cancelled = true;
        j.ac.abort();
      }
    }
  }

  cancelAll(): void {
    this.cancel();
  }

  activeDownloads(): string[] {
    return [...this.jobs.keys()];
  }

  async download(regionId: string): Promise<GeodataEntry> {
    if (!isRegionId(regionId)) throw new GeodataError('BAD_REQUEST', 'invalid regionId');
    const existing = this.jobs.get(regionId);
    if (existing) return existing.promise; // one download per region: join it
    if (this.jobs.size >= MAX_CONCURRENT_DOWNLOADS) {
      throw new GeodataError('DOWNLOAD_FAILED', `${MAX_CONCURRENT_DOWNLOADS} downloads are already running; wait for one to finish or cancel it`);
    }
    const cat = await this.loadCatalogue(false);
    const region = cat.find((c) => c.region.id === regionId)?.region;
    if (!region) throw new GeodataError('BAD_REQUEST', 'unknown region');
    // Re-check after the await: another call may have started meanwhile.
    const raced = this.jobs.get(regionId);
    if (raced) return raced.promise;
    if (this.jobs.size >= MAX_CONCURRENT_DOWNLOADS) {
      throw new GeodataError('DOWNLOAD_FAILED', `${MAX_CONCURRENT_DOWNLOADS} downloads are already running; wait for one to finish or cancel it`);
    }
    const job: Job = { regionId, ac: new AbortController(), cancelled: false, stalled: false, remaining: 0, promise: undefined as never };
    job.promise = this.run(job, region).finally(() => this.jobs.delete(regionId));
    this.jobs.set(regionId, job);
    job.promise.catch(() => undefined);
    return job.promise;
  }

  private async run(job: Job, region: GeodataRegion): Promise<GeodataEntry> {
    const regionId = region.id;
    const dir = join(this.o.dir, ...regionId.split('/'));
    const fileName = basename(new URL(region.pbfUrl).pathname);
    const final = join(dir, fileName);
    const part = `${final}.part`;
    const base = fileName.slice(0, -'.osm.pbf'.length);
    let emitted = false;
    const fail = (message: string, cancelled = false): GeodataError => {
      emitted = true;
      let partBytes = 0; // real resumable bytes on disk, so the UI keeps showing them
      try {
        partBytes = statSync(part).size;
      } catch {
        /* no part file */
      }
      this.emit({ regionId, phase: 'error', receivedBytes: partBytes, message: cancelled ? 'cancelled' : message });
      return new GeodataError(cancelled ? 'CANCELLED' : 'DOWNLOAD_FAILED', message);
    };
    try {
      await mkdir(dir, { recursive: true });

      let lastErr = '';
      let sourceDate: string | undefined;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (job.cancelled) throw fail('download cancelled', true);
        try {
          sourceDate = (await this.pass(job, region, part)) ?? sourceDate;
          lastErr = '';
          break;
        } catch (e) {
          if (job.cancelled) throw fail('download cancelled', true);
          if (e instanceof Retryable && attempt < MAX_RETRIES) {
            lastErr = e.message;
            if (e.resetPart) await this.clearPart(part);
            this.log(`${regionId}: ${e.message}; retrying (${attempt + 1}/${MAX_RETRIES})`);
            this.emit({ regionId, phase: 'download', receivedBytes: (await fileSize(part)) ?? 0, message: `${e.message}; retrying...` });
            if (!(await sleep(this.o.retryDelayMs * 2 ** attempt, job.ac.signal)) || job.cancelled) throw fail('download cancelled', true);
            continue;
          }
          if (e instanceof Retryable) throw fail(`${e.message} (gave up after ${MAX_RETRIES} retries; run it again to resume)`);
          if (e instanceof GeodataError) throw fail(e.message.replace(/^DOWNLOAD_FAILED: /, ''));
          throw fail((e as Error).message || String(e));
        }
      }
      if (lastErr) throw fail(lastErr);

      const size = (await fileSize(part)) ?? 0;
      // ── verify ──
      const expected = await this.fetchMd5(region.pbfUrl, job, (message) =>
        this.emit({ regionId, phase: 'verify', receivedBytes: size, totalBytes: size, message }),
      );
      if (job.cancelled) throw fail('download cancelled', true);
      let verified = false;
      if (expected) {
        this.emit({ regionId, phase: 'verify', receivedBytes: 0, totalBytes: size, message: 'verifying checksum' });
        const got = await this.md5File(part, job, (n) => this.emit({ regionId, phase: 'verify', receivedBytes: n, totalBytes: size }));
        if (got !== expected) {
          await this.clearPart(part);
          throw fail(`checksum mismatch for ${fileName} (expected ${expected}, got ${got}); the file may have been updated on the server during the download. Try again.`);
        }
        verified = true;
      } else {
        this.log(`${regionId}: no .md5 available, file stays unverified`);
      }
      const doneMessage = verified ? undefined : 'Downloaded, but the checksum file could not be fetched; the file is NOT verified.';
      if (job.cancelled) throw fail('download cancelled', true);

      // ── commit: drop the old sidecar first so a crash never pairs a new pbf with a stale sidecar ──
      await rm(join(dir, `${base}.json`), { force: true });
      await this.removeIndexFiles(dir, fileName); // python's index of the file being replaced is stale now
      await rename(part, final);
      await fsyncDir(dir);
      await rm(`${part}.json`, { force: true });
      const entry: GeodataEntry = {
        regionId,
        name: region.name,
        pbfPath: final,
        sizeBytes: size,
        downloadedAt: new Date().toISOString(),
        ...(sourceDate ? { sourceDate } : {}),
        verified,
      };
      await writeFileAtomic(join(dir, `${base}.json`), JSON.stringify(entry, null, 1));
      this.sizes && (this.sizes[regionId] = { size, at: Date.now() });
      this.emit({ regionId, phase: 'done', receivedBytes: size, totalBytes: size, ...(doneMessage ? { message: doneMessage } : {}) });
      return entry;
    } catch (e) {
      if (e instanceof GeodataError) {
        if (emitted) throw e;
        throw fail(e.message.replace(/^[A-Z_]+: /, ''), e.code === 'CANCELLED');
      }
      throw fail((e as Error).message || String(e));
    }
  }

  /** Remove `<file>.vwidx*` (python's pbf index and its partial files) next to a pbf. */
  private async removeIndexFiles(dir: string, fileName: string): Promise<void> {
    try {
      for (const n of await readdir(dir)) if (n.startsWith(`${fileName}.vwidx`)) await rm(join(dir, n), { force: true });
    } catch {
      /* dir missing */
    }
  }

  private async clearPart(part: string): Promise<void> {
    await rm(part, { force: true });
    await rm(`${part}.json`, { force: true });
  }

  /** One HTTP attempt: resume from the .part size, stream to disk. Returns Last-Modified of the remote file. */
  private async pass(job: Job, region: GeodataRegion, part: string): Promise<string | undefined> {
    const regionId = region.id;
    let offset = (await fileSize(part)) ?? 0;
    let meta: PartMeta | null = null;
    if (offset > 0) {
      meta = await readJsonFile<PartMeta>(`${part}.json`).catch(() => null);
      let metaOk = false;
      try {
        metaOk = !!meta && typeof meta.url === 'string' && this.o.urlPolicy(new URL(meta.url));
      } catch {
        metaOk = false;
      }
      if (!metaOk) meta = null; // corrupt or foreign sidecar counts as missing
      if (!meta) {
        offset = 0; // no validators/URL known: cannot trust the bytes
        await this.clearPart(part);
      }
    }
    // Resume against the exact (dated, immutable) file we started with; first attempt uses the catalogue URL.
    let url = meta && offset > 0 ? meta.url : region.pbfUrl;
    const headers: Record<string, string> = {};
    if (offset > 0) {
      headers['Range'] = `bytes=${offset}-`;
      const v = meta?.etag ?? meta?.lastModified;
      if (v) headers['If-Range'] = v;
    }
    let reqRes;
    try {
      reqRes = await this.request(url, { headers, signal: job.ac.signal });
    } catch (e) {
      if (job.cancelled) throw e;
      if (e instanceof NetTimeout) throw new Retryable(e.message.replace(/^DOWNLOAD_FAILED: /, ''));
      if (e instanceof GeodataError) throw e;
      throw new Retryable(`network error: ${errMsg(e)}`);
    }
    const { res, finalUrl } = reqRes;
    url = finalUrl;
    const discard = (): Promise<void> => res.body?.cancel().catch(() => undefined) ?? Promise.resolve();

    let total: number | undefined;
    if (res.status === 416) {
      await discard();
      const m = /bytes \*\/(\d+)/.exec(res.headers.get('content-range') ?? '');
      if (m && Number(m[1]) === offset) return meta?.lastModified; // already complete
      throw new Retryable('partial file no longer valid, restarting', true);
    }
    if (res.status === 404 || res.status === 410 || res.status === 403) {
      await discard();
      if (meta && url !== region.pbfUrl && offset > 0) throw new Retryable('resume target gone, restarting', true);
      throw new GeodataError('DOWNLOAD_FAILED', `the server does not have this file (HTTP ${res.status})`);
    }
    if (res.status === 429 || res.status >= 500) {
      await discard();
      throw new Retryable(`server busy (HTTP ${res.status})`);
    }
    if (res.status === 200) {
      if (offset > 0) {
        offset = 0; // server ignored Range or the file changed (If-Range): start over
        await this.clearPart(part);
      }
      const n = Number(res.headers.get('content-length'));
      total = Number.isFinite(n) && n > 0 ? n : undefined;
    } else if (res.status === 206) {
      const m = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(res.headers.get('content-range') ?? '');
      if (!m || Number(m[1]) !== offset) {
        await discard();
        throw new Retryable('unexpected Content-Range, restarting', true);
      }
      total = m[3] === '*' ? undefined : Number(m[3]);
    } else {
      await discard();
      throw new GeodataError('DOWNLOAD_FAILED', `unexpected server response (HTTP ${res.status})`);
    }
    if (!res.body) throw new Retryable('empty response');

    const lastModified = res.headers.get('last-modified') ?? undefined;
    const pm: PartMeta = { url, etag: res.headers.get('etag') ?? undefined, lastModified, ...(total ? { total } : {}) };

    // free space (remaining bytes + margin) before a single byte is written
    const remaining = total !== undefined ? total - offset : (this.sizes?.[regionId]?.size ?? 0);
    if (remaining > 0) {
      let free = Infinity;
      try {
        const sf = await (this.o.statfsFn ?? statfs)(join(part, '..'));
        free = sf.bavail * sf.bsize;
      } catch {
        /* unknown filesystem: skip the check */
      }
      job.remaining = remaining;
      let others = 0; // other running downloads still have bytes to write into the same disk
      for (const j of this.jobs.values()) if (j !== job) others += j.remaining;
      if (free < remaining + others + this.o.freeMarginBytes) {
        await discard();
        throw new GeodataError('DOWNLOAD_FAILED', `not enough free disk space: need about ${fmtBytes(remaining + this.o.freeMarginBytes)}, ${fmtBytes(free)} available`);
      }
    }
    await writeFileAtomic(`${part}.json`, JSON.stringify(pm));

    const fh = await open(part, offset > 0 ? 'a' : 'w');
    let received = offset;
    const samples: Array<[number, number]> = [[Date.now(), received]];
    let lastEmit = 0;
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        job.stalled = true;
        job.ac.abort();
      }, this.o.stallMs);
    };
    const emitProgress = (force: boolean): void => {
      const now = Date.now();
      if (!force && now - lastEmit < 200) return;
      lastEmit = now;
      samples.push([now, received]);
      while (samples.length > 2 && now - samples[0][0] > 4000) samples.shift();
      const [t0, b0] = samples[0];
      const bytesPerSec = now > t0 ? Math.round(((received - b0) * 1000) / (now - t0)) : undefined;
      this.emit({ regionId, phase: 'download', receivedBytes: received, ...(total ? { totalBytes: total } : {}), ...(bytesPerSec !== undefined ? { bytesPerSec } : {}) });
    };
    emitProgress(true);
    armStall();
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armStall();
        let off = 0;
        while (off < value.length) {
          const { bytesWritten } = await fh.write(value, off, value.length - off);
          off += bytesWritten;
        }
        received += value.length;
        if (total !== undefined) job.remaining = Math.max(0, total - received);
        emitProgress(false);
      }
    } catch (e) {
      if (job.cancelled) throw e;
      if (job.stalled) {
        job.stalled = false;
        job.ac = job.cancelled ? job.ac : new AbortController();
        throw new Retryable('connection stalled');
      }
      if ((e as NodeJS.ErrnoException)?.code === 'ENOSPC') throw new GeodataError('DOWNLOAD_FAILED', 'disk full while writing the file');
      if ((e as NodeJS.ErrnoException)?.syscall === 'write') throw new GeodataError('DOWNLOAD_FAILED', `cannot write the file: ${errMsg(e)}`);
      throw new Retryable(`connection lost: ${errMsg(e)}`);
    } finally {
      clearTimeout(stallTimer);
      await fh.sync().catch(() => undefined);
      await fh.close().catch(() => undefined);
    }
    emitProgress(true);
    if (total !== undefined && received !== total) throw new Retryable(`connection closed early (${received} of ${total} bytes)`);
    return lastModified;
  }

  /**
   * Fetch the expected md5. Network errors / 5xx / 429 are retried up to 2 more times with backoff; a 404 or an
   * unparsable body is final (the server simply has no usable checksum). Returns null => file stays unverified.
   */
  private async fetchMd5(pbfUrl: string, job: Job, note: (m: string) => void): Promise<string | null> {
    const attempts = 3;
    for (let i = 0; i < attempts; i++) {
      if (job.cancelled) return null;
      try {
        const { res } = await this.withTimeout(15_000, (signal) =>
          this.request(`${pbfUrl}.md5`, { signal: AbortSignal.any([signal, job.ac.signal]) }),
        );
        if (res.ok) return parseMd5((await this.readCapped(res, 4096, job.ac.signal)).toString('utf8'));
        await res.body?.cancel().catch(() => undefined);
        if (res.status !== 429 && res.status < 500) return null;
        this.log(`md5 fetch: HTTP ${res.status}`);
      } catch (e) {
        if (job.cancelled) return null;
        this.log(`md5 fetch failed: ${errMsg(e)}`);
      }
      if (i < attempts - 1) {
        note(`checksum file unavailable, retrying (${i + 1}/${attempts - 1})...`);
        if (!(await sleep(this.o.retryDelayMs * 2 ** i, job.ac.signal))) return null;
      }
    }
    return null;
  }

  private async md5File(path: string, job: Job, onBytes: (n: number) => void): Promise<string> {
    const h = createHash('md5');
    let n = 0;
    let last = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
      if (job.cancelled) throw new GeodataError('CANCELLED', 'download cancelled');
      h.update(chunk as Buffer);
      n += (chunk as Buffer).length;
      if (Date.now() - last > 200) {
        last = Date.now();
        onBytes(n);
      }
    }
    onBytes(n);
    return h.digest('hex');
  }
}

const errMsg = (e: unknown): string => {
  const x = e as { message?: string; cause?: { message?: string; code?: string } };
  return x?.cause?.code ?? x?.cause?.message ?? x?.message ?? String(e);
};

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return 'unknown';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
