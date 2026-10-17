import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GeodataProgress } from '../src/shared/contract';
import { defaultUrlPolicy, GeodataManager, parseCatalogue, parseMd5, suggestRegions } from '../src/main/geodata';
import { multiPolyAreaKm2, multiPolyCoversBBox, multiPolyIntersectsBBox, type Poly } from '../src/main/geometry';

const sq = (lon0: number, lat0: number, lon1: number, lat1: number): Poly[] => [[[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]]];
const bb = (lonMin: number, latMin: number, lonMax: number, latMax: number) => ({ lonMin, latMin, lonMax, latMax });

describe('geometry', () => {
  const big = sq(0, 0, 10, 10);
  it('covers / intersects', () => {
    expect(multiPolyCoversBBox(big, bb(1, 1, 2, 2))).toBe(true);
    expect(multiPolyCoversBBox(big, bb(9, 9, 11, 11))).toBe(false);
    expect(multiPolyIntersectsBBox(big, bb(9, 9, 11, 11))).toBe(true);
    expect(multiPolyIntersectsBBox(big, bb(20, 20, 21, 21))).toBe(false);
    expect(multiPolyIntersectsBBox(big, bb(-5, -5, 15, 15))).toBe(true);
    expect(multiPolyCoversBBox(big, bb(-5, -5, 15, 15))).toBe(false);
  });
  it('holes and concave shapes', () => {
    const donut: Poly[] = [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]];
    expect(multiPolyCoversBBox(donut, bb(4.5, 4.5, 5.5, 5.5))).toBe(false);
    expect(multiPolyCoversBBox(donut, bb(3, 3, 7, 7))).toBe(false);
    expect(multiPolyCoversBBox(donut, bb(1, 1, 2, 2))).toBe(true);
    const L: Poly[] = [[[[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]]]];
    expect(multiPolyCoversBBox(L, bb(1, 1, 3, 9))).toBe(true);
    expect(multiPolyCoversBBox(L, bb(1, 1, 9, 9))).toBe(false);
  });
  it('area ranks small below large', () => {
    expect(multiPolyAreaKm2(sq(0, 0, 1, 1))).toBeLessThan(multiPolyAreaKm2(sq(0, 0, 5, 5)));
    expect(multiPolyAreaKm2(sq(0, 0, 1, 1))).toBeGreaterThan(10_000);
  });
});

const feature = (id: string, parent: string | undefined, url: string, poly: Poly[]) => ({
  type: 'Feature', properties: { id, name: id.toUpperCase(), parent, urls: { pbf: url } }, geometry: { type: 'MultiPolygon', coordinates: poly },
});

describe('catalogue parsing and suggestions', () => {
  const g = (p: string) => `https://download.geofabrik.de/${p}`;
  const cat = parseCatalogue({
    type: 'FeatureCollection',
    features: [
      feature('europe', undefined, g('europe-latest.osm.pbf'), sq(-30, 30, 50, 75)),
      feature('france', 'europe', g('europe/france-latest.osm.pbf'), sq(-5, 41, 10, 51)),
      feature('ile-de-france', 'france', g('europe/france/ile-de-france-latest.osm.pbf'), sq(1.4, 48, 3.6, 49.3)),
      feature('us/alabama', 'us', g('north-america/us/alabama-latest.osm.pbf'), sq(-89, 30, -85, 35)),
      feature('evil', 'x', 'https://evil.example.com/x.osm.pbf', sq(-180, -90, 180, 90)),
      feature('../bad', 'x', g('bad.osm.pbf'), sq(-180, -90, 180, 90)),
      feature('notpbf', 'x', g('x.zip'), sq(-180, -90, 180, 90)),
      { type: 'Feature', properties: { id: 'nourl' }, geometry: null },
    ],
  });
  it('drops entries with foreign hosts, bad ids and non-pbf urls', () => {
    expect(cat.map((c) => c.region.id)).toEqual(['europe', 'france', 'ile-de-france', 'us/alabama']);
    expect(cat[2].region.parent).toBe('france');
  });
  it('suggests covering regions smallest first', () => {
    expect(suggestRegions(cat, { latMin: 48.85, lonMin: 2.29, latMax: 48.86, lonMax: 2.3 }).map((x) => x.id)).toEqual(['ile-de-france', 'france', 'europe']);
  });
  it('falls back to intersecting regions when none covers the bbox; a covering region wins', () => {
    expect(suggestRegions(cat, { latMin: 28, lonMin: -90, latMax: 32, lonMax: -88 }).map((x) => x.id)).toEqual(['us/alabama']);
    expect(suggestRegions(cat, { latMin: 45, lonMin: 49, latMax: 46, lonMax: 52 }).map((x) => x.id)).toEqual(['europe']);
    // covering first, then merely-intersecting regions (smallest first), no duplicates
    expect(suggestRegions(cat, { latMin: 40.5, lonMin: -6, latMax: 41.5, lonMax: -4 }).map((x) => x.id)).toEqual(['europe', 'france']);
    expect(suggestRegions(cat, { latMin: 48.5, lonMin: -6, latMax: 49, lonMax: -4 }).map((x) => x.id)).toEqual(['europe', 'france']);
    // border bbox: sees the sub-regions on both sides, covering one first
    expect(suggestRegions(cat, { latMin: 48.5, lonMin: 0.5, latMax: 49, lonMax: 2 }).map((x) => x.id)).toEqual(['france', 'europe', 'ile-de-france']);
    const flags = suggestRegions(cat, { latMin: 48.5, lonMin: 0.5, latMax: 49, lonMax: 2 }).map((x) => `${x.id}:${x.covers}`);
    expect(flags).toEqual(['france:true', 'europe:true', 'ile-de-france:false']);
    expect(suggestRegions(cat, { latMin: -50, lonMin: 100, latMax: -49, lonMax: 101 })).toEqual([]);
  });
  it('default url policy', () => {
    expect(defaultUrlPolicy(new URL('https://download.geofabrik.de/a.osm.pbf'))).toBe(true);
    for (const u of ['http://download.geofabrik.de/a', 'https://evil.com/a', 'https://download.geofabrik.de.evil.com/a', 'https://user@download.geofabrik.de/a', 'https://download.geofabrik.de:8443/a', 'file:///etc/passwd']) {
      expect(defaultUrlPolicy(new URL(u))).toBe(false);
    }
  });
  it('md5 parsing', () => {
    expect(parseMd5('85be1fc628f38b08665534d5ae00f5d1  monaco-latest.osm.pbf\n')).toBe('85be1fc628f38b08665534d5ae00f5d1');
    expect(parseMd5('<html>nope')).toBeNull();
    expect(parseMd5('85BE1FC628F38B08665534D5AE00F5D1')).toBe('85be1fc628f38b08665534d5ae00f5d1');
  });
});

// ───────────────────── downloads against a local HTTP server ─────────────────────
interface Behaviour {
  dropAfter?: number;       // first full response closes the socket after N bytes (once)
  ignoreRange?: boolean;
  md5?: 'ok' | 'bad' | 'missing' | 'flaky' | 'down';
  slowMs?: number;          // delay between 16 KiB chunks
  status?: number;          // force status for the pbf
  hang?: boolean;           // never answer the pbf request
  indexMode?: 'ok' | 'stall' | 'huge';
  indexHits?: number;
  md5Hits: number;
  rangeHeaders: string[];
  userAgents: string[];
  dropped?: boolean;
  requests: number;
}
let server: Server;
let base = '';
let DATA = randomBytes(300_000);
let beh: Behaviour;
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');
const indexJson = () => JSON.stringify({
  type: 'FeatureCollection',
  features: [
    feature('europe', undefined, `${base}/europe-latest.osm.pbf`, sq(-30, 30, 50, 75)),
    feature('test', 'europe', `${base}/europe/test-latest.osm.pbf`, sq(1, 1, 3, 3)),
    feature('us/test2', 'us', `${base}/us/test2-latest.osm.pbf`, sq(1, 1, 3, 3)),
  ],
});

function serve(req: IncomingMessage, res: ServerResponse): void {
  beh.userAgents.push(String(req.headers['user-agent']));
  const url = req.url ?? '';
  if (url === '/index-v1.json') {
    beh.indexHits = (beh.indexHits ?? 0) + 1;
    if (beh.indexMode === 'stall') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"type":"FeatureCol'); return; }
    if (beh.indexMode === 'huge') { res.writeHead(200); res.end('x'.repeat(100_000)); return; }
    const body = indexJson();
    const etag = '"idx1"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { ETag: etag, 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }
  if (url.endsWith('-latest.osm.pbf') && !url.startsWith('/europe-latest')) {
    res.writeHead(307, { Location: url.replace('-latest', '-261016') });
    res.end();
    return;
  }
  if (url.endsWith('.osm.pbf.md5')) {
    beh.md5Hits++;
    if (beh.md5 === 'missing') { res.writeHead(404); res.end('nope'); return; }
    if (beh.md5 === 'down' || (beh.md5 === 'flaky' && beh.md5Hits <= 2)) { res.writeHead(503); res.end('busy'); return; }
    const h = beh.md5 === 'bad' ? '0'.repeat(32) : md5(DATA);
    res.writeHead(200);
    res.end(`${h}  test-latest.osm.pbf\n`);
    return;
  }
  if (url.endsWith('-261016.osm.pbf')) {
    beh.requests++;
    if (beh.hang) return;
    if (beh.status) { res.writeHead(beh.status); res.end('x'); return; }
    const etag = '"v1"';
    const headers: Record<string, string | number> = { ETag: etag, 'Last-Modified': 'Fri, 16 Oct 2026 03:57:19 GMT', 'Accept-Ranges': 'bytes' };
    if (req.method === 'HEAD') { res.writeHead(200, { ...headers, 'Content-Length': DATA.length }); res.end(); return; }
    let start = 0;
    const range = /bytes=(\d+)-/.exec(String(req.headers.range ?? ''));
    if (range) beh.rangeHeaders.push(`${req.headers.range}|${req.headers['if-range'] ?? ''}`);
    const ifRangeOk = !req.headers['if-range'] || req.headers['if-range'] === etag;
    if (range && !beh.ignoreRange && ifRangeOk) start = Number(range[1]);
    if (start >= DATA.length) { res.writeHead(416, { 'Content-Range': `bytes */${DATA.length}` }); res.end(); return; }
    const partial = start > 0;
    res.writeHead(partial ? 206 : 200, {
      ...headers, 'Content-Length': DATA.length - start,
      ...(partial ? { 'Content-Range': `bytes ${start}-${DATA.length - 1}/${DATA.length}` } : {}),
    });
    const CH = 16 * 1024;
    let pos = start;
    const limit = !partial && beh.dropAfter !== undefined && !beh.dropped ? beh.dropAfter : DATA.length;
    const tick = (): void => {
      if (res.destroyed) return;
      if (pos >= limit) {
        if (limit < DATA.length) { beh.dropped = true; res.destroy(); return; }
        res.end();
        return;
      }
      const end = Math.min(pos + CH, limit);
      res.write(DATA.subarray(pos, end));
      pos = end;
      if (beh.slowMs) setTimeout(tick, beh.slowMs); else setImmediate(tick);
    };
    tick();
    return;
  }
  res.writeHead(404);
  res.end();
}

beforeAll(async () => {
  server = createServer(serve);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

let dir: string;
let events: GeodataProgress[];
let logs: string[];
const mkMgr = (o: Partial<ConstructorParameters<typeof GeodataManager>[0]> = {}) =>
  new GeodataManager({
    dir, version: '9.9.9', log: (m) => logs.push(m), onProgress: (e) => events.push(e),
    urlPolicy: (u) => u.hostname === '127.0.0.1' && u.protocol === 'http:',
    indexUrl: `${base}/index-v1.json`, retryDelayMs: 5, stallMs: 2000, ...o,
  });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vw-geo-'));
  events = []; logs = [];
  beh = { rangeHeaders: [], userAgents: [], requests: 0, md5Hits: 0 };
  DATA = randomBytes(300_000);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const partPath = () => join(dir, 'test', 'test-latest.osm.pbf.part');

describe('GeodataManager catalogue', () => {
  it('fetches, caches, uses ETag and works offline from cache', async () => {
    const r = await mkMgr().listRegions();
    expect(r.map((x) => x.id)).toEqual(['europe', 'test', 'us/test2']);
    expect(r.every((x) => x.downloaded === false)).toBe(true);
    expect(existsSync(join(dir, 'index-v1.json'))).toBe(true);
    await mkMgr().listRegions();
    expect(beh.indexHits).toBe(1);
    await mkMgr().listRegions({ refresh: true });
    expect(beh.indexHits).toBe(2);
    expect(beh.userAgents.every((u) => u === 'VoxelWorlds/9.9.9')).toBe(true);
    const off = mkMgr({ indexUrl: 'http://127.0.0.1:1/index-v1.json' });
    expect((await off.listRegions()).length).toBe(3); // normal list: cache
    // explicit refresh that cannot reach the server REJECTS and names the cache date; a normal list still works after
    await expect(off.listRegions({ refresh: true })).rejects.toThrow(/DOWNLOAD_FAILED: cannot reach download\.geofabrik\.de; showing saved list from \d{4}-\d{2}-\d{2}/);
    expect((await off.listRegions()).length).toBe(3);
  });
  it('fails clearly when offline without a cache', async () => {
    await expect(mkMgr({ indexUrl: 'http://127.0.0.1:1/index-v1.json' }).listRegions()).rejects.toThrow(/DOWNLOAD_FAILED: cannot load the Geofabrik region list/);
  });
  it('a stalled catalogue body times out (does not hang) and falls back to the cache', async () => {
    beh.indexMode = 'stall';
    const t0 = Date.now();
    await expect(mkMgr({ stallMs: 150 }).listRegions()).rejects.toThrow(/cannot load the Geofabrik region list.*stalled/);
    expect(Date.now() - t0).toBeLessThan(3000);
    beh.indexMode = 'ok';
    await mkMgr().listRegions();
    beh.indexMode = 'stall';
    await expect(mkMgr({ stallMs: 150 }).listRegions({ refresh: true })).rejects.toThrow(/showing saved list/);
    expect((await mkMgr({ stallMs: 150 }).listRegions()).length).toBe(3);
    expect(logs.some((l) => /using cached copy/.test(l))).toBe(true);
  });
  it('enforces the catalogue size cap while streaming', async () => {
    beh.indexMode = 'huge';
    await expect(mkMgr({ indexMaxBytes: 1000 }).listRegions()).rejects.toThrow(/too large|larger than/);
  });
  it('suggest returns sizes via HEAD and caches them (sizes.json validated on load)', async () => {
    const s = await mkMgr().suggest(bb(1.5, 1.5, 2, 2));
    expect(s.map((x) => x.id).sort()).toEqual(['test', 'us/test2']);
    expect(s.every((x) => x.covers === true)).toBe(true);
    expect(s[0].sizeBytes).toBe(DATA.length);
    const saved = JSON.parse(readFileSync(join(dir, 'sizes.json'), 'utf8'));
    expect(saved.test.size).toBe(DATA.length);
    // garbage entries are dropped, legacy numbers are accepted but refetched
    writeFileSync(join(dir, 'sizes.json'), JSON.stringify({ '../evil': 5, test: -1, 'us/test2': 'x', europe: 123, nested: { size: 'a' } }));
    const r = await mkMgr().listRegions();
    expect(r.find((x) => x.id === 'europe')?.sizeBytes).toBe(123);
    expect(r.find((x) => x.id === 'test')?.sizeBytes).toBeUndefined();
    writeFileSync(join(dir, 'sizes.json'), '{broken');
    await expect(mkMgr().listRegions()).resolves.toBeTruthy();
  });
});

describe('sizes and out-of-band files', () => {
  it('a downloaded region reports its local file size; out-of-band extracts are noticed without restart', async () => {
    const m = mkMgr();
    await m.listRegions();
    mkdirSync(join(dir, 'us', 'test2'), { recursive: true });
    writeFileSync(join(dir, 'us', 'test2', 'manual.osm.pbf'), randomBytes(1234));
    expect((await m.listEntries()).map((e) => e.regionId)).toEqual(['us/test2']);
    const r = await m.listRegions();
    expect(r.find((x) => x.id === 'us/test2')).toMatchObject({ downloaded: true, sizeBytes: 1234 });
    rmSync(join(dir, 'us'), { recursive: true });
    expect((await m.listRegions()).find((x) => x.id === 'us/test2')?.downloaded).toBe(false);
  });
  it('stale known sizes are refreshed in the background; HEAD is retried', async () => {
    const m = mkMgr();
    writeFileSync(join(dir, 'sizes.json'), JSON.stringify({ test: { size: 5, at: 1 } }));
    const r = await m.listRegions();
    expect(r.find((x) => x.id === 'test')?.sizeBytes).toBe(5); // immediate answer from the cache
    await waitFor(() => { try { return JSON.parse(readFileSync(join(dir, 'sizes.json'), 'utf8')).test.size === DATA.length; } catch { return false; } });
    expect((await m.listRegions()).find((x) => x.id === 'test')?.sizeBytes).toBe(DATA.length);
  });
});

describe('security and index files', () => {
  it('rejects a region directory symlinked outside the geodata dir (realpath containment)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'vw-outside-'));
    try {
      writeFileSync(join(outside, 'evil.osm.pbf'), randomBytes(100));
      symlinkSync(outside, join(dir, 'test'));
      const m = mkMgr();
      expect((await m.entryFor('test'))?.pbfPath).toBeTruthy(); // visible through the link...
      await expect(m.resolveDataSource({ kind: 'pbf', regionId: 'test' })).rejects.toThrow(/BAD_REQUEST: region not downloaded/); // ...but never handed to python
      expect((await m.listEntries()).map((e) => e.regionId)).toEqual([]); // symlinks are ignored by the inventory
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it('a symlinked .osm.pbf file pointing outside is rejected too', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'vw-outside-'));
    try {
      writeFileSync(join(outside, 'x.osm.pbf'), randomBytes(100));
      mkdirSync(join(dir, 'test'), { recursive: true });
      symlinkSync(join(outside, 'x.osm.pbf'), join(dir, 'test', 'test-latest.osm.pbf'));
      await expect(mkMgr().resolveDataSource({ kind: 'pbf', regionId: 'test' })).rejects.toThrow(/region not downloaded/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it('delete removes <pbf>.vwidx* index files; they are never listed; a re-download drops the stale index', async () => {
    const m = mkMgr();
    const e = await m.download('test');
    const side = [`${e.pbfPath}.vwidx`, `${e.pbfPath}.vwidx.1.part`, `${e.pbfPath}.vwidx.part`];
    for (const f of side) writeFileSync(f, 'idx');
    expect((await m.listEntries()).map((x) => x.regionId)).toEqual(['test']);
    expect((await m.listEntries())[0].sizeBytes).toBe(DATA.length);
    await mkMgr().download('test'); // replaced file => stale index removed
    for (const f of side) expect(existsSync(f)).toBe(false);
    for (const f of side) writeFileSync(f, 'idx');
    await m.delete('test');
    expect(existsSync(join(dir, 'test'))).toBe(false);
  });
});

describe('GeodataManager download', () => {
  it('downloads through a redirect, verifies md5, writes sidecar atomically, lists it', async () => {
    const m = mkMgr();
    const e = await m.download('test');
    expect(e.verified).toBe(true);
    expect(e.sizeBytes).toBe(DATA.length);
    expect(e.sourceDate).toMatch(/2026/);
    expect(readFileSync(e.pbfPath).equals(DATA)).toBe(true);
    expect(readdirSync(join(dir, 'test')).sort()).toEqual(['test-latest.json', 'test-latest.osm.pbf']);
    expect((await m.listEntries()).map((x) => x.regionId)).toEqual(['test']);
    expect((await m.listRegions()).find((r) => r.id === 'test')?.downloaded).toBe(true);
    const phases = events.map((x) => x.phase);
    expect(phases).toContain('download'); expect(phases).toContain('verify'); expect(phases.at(-1)).toBe('done');
    const dl = events.filter((x) => x.phase === 'download');
    expect(dl.at(-1)!.receivedBytes).toBe(DATA.length);
    expect(dl.at(-1)!.totalBytes).toBe(DATA.length);
    expect(events.every((x) => x.regionId === 'test')).toBe(true);
    expect(await m.resolveDataSource({ kind: 'pbf', regionId: 'test', pbfPath: '/etc/passwd' })).toEqual({ kind: 'pbf', regionId: 'test', pbfPath: e.pbfPath });
    expect(await m.resolveDataSource(undefined)).toEqual({ kind: 'overpass' });
    await expect(m.resolveDataSource({ kind: 'pbf', regionId: 'europe' })).rejects.toThrow(/BAD_REQUEST: region not downloaded/);
    await expect(m.resolveDataSource({ kind: 'pbf', regionId: '../x' })).rejects.toThrow(/BAD_REQUEST/);
  });

  it('nested region ids use nested dirs and delete leaves siblings alone, prunes empty parents', async () => {
    const m = mkMgr();
    await m.download('us/test2');
    await m.download('test');
    expect((await m.listEntries()).map((x) => x.regionId)).toEqual(['test', 'us/test2']);
    await m.delete('us/test2');
    expect((await m.listEntries()).map((x) => x.regionId)).toEqual(['test']);
    expect(existsSync(join(dir, 'us'))).toBe(false);
    await m.delete('test');
    expect(await m.listEntries()).toEqual([]);
    await expect(m.delete('../etc')).rejects.toThrow(/BAD_REQUEST/);
    await m.delete('test');
  });

  it('resumes after a dropped connection with Range + If-Range (single download call)', async () => {
    beh.dropAfter = 100_000;
    const e = await mkMgr().download('test');
    expect(readFileSync(e.pbfPath).equals(DATA)).toBe(true);
    expect(beh.rangeHeaders.length).toBe(1);
    const [rng, ifr] = beh.rangeHeaders[0].split('|');
    expect(Number(/bytes=(\d+)-/.exec(rng)![1])).toBeGreaterThan(0);
    expect(ifr).toBe('"v1"');
    expect(logs.some((l) => /retrying/.test(l))).toBe(true);
  });

  it('cancel keeps the .part, the error event reports its real size, and a later run resumes', async () => {
    beh.slowMs = 40;
    const m = mkMgr();
    const p = m.download('test');
    p.catch(() => undefined);
    await waitFor(() => events.some((x) => x.phase === 'download' && x.receivedBytes > 60_000));
    m.cancel('test');
    await expect(p).rejects.toThrow(/^CANCELLED/);
    const kept = statSync(partPath()).size;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(DATA.length);
    const last = events.at(-1)!;
    expect(last.phase).toBe('error');
    expect(last.receivedBytes).toBe(kept);
    expect(m.activeDownloads()).toEqual([]);
    beh.slowMs = 0;
    const e = await mkMgr().download('test');
    expect(readFileSync(e.pbfPath).equals(DATA)).toBe(true);
    expect(beh.rangeHeaders.length).toBe(1);
    expect(beh.rangeHeaders[0].startsWith(`bytes=${kept}-`)).toBe(true);
    expect(existsSync(partPath())).toBe(false);
    expect(existsSync(partPath() + '.json')).toBe(false);
  });

  it('a corrupt .part.json counts as missing: restart from zero without Range', async () => {
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(partPath(), randomBytes(1000));
    writeFileSync(partPath() + '.json', '{ not json');
    const e = await mkMgr().download('test');
    expect(readFileSync(e.pbfPath).equals(DATA)).toBe(true);
    expect(beh.rangeHeaders).toEqual([]);
    // valid JSON of the wrong shape / foreign URL as well
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(partPath(), randomBytes(1000));
    writeFileSync(partPath() + '.json', JSON.stringify({ url: 'https://evil.example.com/x' }));
    await mkMgr().download('test');
    expect(beh.rangeHeaders).toEqual([]);
  });

  it('416 on resume with a complete .part is treated as complete (then verified)', async () => {
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(partPath(), DATA);
    writeFileSync(partPath() + '.json', JSON.stringify({ url: `${base}/europe/test-261016.osm.pbf`, etag: '"v1"', total: DATA.length }));
    const e = await mkMgr().download('test');
    expect(e.verified).toBe(true);
    expect(readFileSync(e.pbfPath).equals(DATA)).toBe(true);
    expect(beh.rangeHeaders.length).toBe(1);
  });

  it('416 with a part of the wrong size restarts from zero', async () => {
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(partPath(), Buffer.concat([DATA, randomBytes(50)])); // bigger than the file on the server
    writeFileSync(partPath() + '.json', JSON.stringify({ url: `${base}/europe/test-261016.osm.pbf`, etag: '"v1"' }));
    const e = await mkMgr().download('test');
    expect(readFileSync(e.pbfPath).equals(DATA)).toBe(true);
  });

  it('restarts from zero when the server ignores Range', async () => {
    beh.dropAfter = 90_000;
    beh.ignoreRange = true;
    const e = await mkMgr().download('test');
    expect(readFileSync(e.pbfPath).equals(DATA)).toBe(true);
    expect(e.verified).toBe(true);
  });

  it('md5 mismatch: error, part removed, nothing published', async () => {
    beh.md5 = 'bad';
    await expect(mkMgr().download('test')).rejects.toThrow(/DOWNLOAD_FAILED: checksum mismatch/);
    expect(readdirSync(join(dir, 'test'))).toEqual([]);
    expect(events.at(-1)!.phase).toBe('error');
  });

  it('md5 missing (404): published but unverified, no retries', async () => {
    beh.md5 = 'missing';
    const e = await mkMgr().download('test');
    expect(e.verified).toBe(false);
    expect(beh.md5Hits).toBe(1);
    expect(events.at(-1)!.message).toMatch(/NOT verified/);
    expect((await mkMgr().listEntries())[0].verified).toBe(false);
  });

  it('md5 flaky (503 twice): retried, ends verified', async () => {
    beh.md5 = 'flaky';
    const e = await mkMgr().download('test');
    expect(e.verified).toBe(true);
    expect(beh.md5Hits).toBe(3);
    expect(events.some((x) => x.phase === 'verify' && /retrying/.test(x.message ?? ''))).toBe(true);
  });

  it('md5 down for good: 3 attempts then unverified with a visible message', async () => {
    beh.md5 = 'down';
    const e = await mkMgr().download('test');
    expect(e.verified).toBe(false);
    expect(beh.md5Hits).toBe(3);
    expect(events.at(-1)).toMatchObject({ phase: 'done' });
    expect(events.at(-1)!.message).toMatch(/NOT verified/);
  });

  it('cancel() without id cancels everything (what quitting does)', async () => {
    beh.slowMs = 40;
    const m = mkMgr();
    const a = m.download('test');
    const b = m.download('us/test2');
    a.catch(() => undefined); b.catch(() => undefined);
    await waitFor(() => m.activeDownloads().length === 2 && events.some((x) => x.phase === 'download' && x.receivedBytes > 20_000));
    m.cancelAll();
    await expect(a).rejects.toThrow(/^CANCELLED/);
    await expect(b).rejects.toThrow(/^CANCELLED/);
    expect(await m.listEntries()).toEqual([]);
  });

  it('delete while downloading cancels the job and removes the .part', async () => {
    beh.slowMs = 40;
    const m = mkMgr();
    const a = m.download('test');
    a.catch(() => undefined);
    await waitFor(() => events.some((x) => x.phase === 'download' && x.receivedBytes > 20_000));
    await m.delete('test');
    await expect(a).rejects.toThrow(/^CANCELLED/);
    expect(existsSync(join(dir, 'test'))).toBe(false);
    expect(m.activeDownloads()).toEqual([]);
  });

  it('the retry delay is cancellable (does not wait out the backoff)', async () => {
    beh.status = 503;
    const m = mkMgr({ retryDelayMs: 30_000 });
    const t0 = Date.now();
    const p = m.download('test');
    p.catch(() => undefined);
    await waitFor(() => events.some((x) => /retrying/.test(x.message ?? '')));
    m.cancel('test');
    await expect(p).rejects.toThrow(/^CANCELLED/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('joins a second call for the same region and limits concurrency to 2', async () => {
    beh.slowMs = 40;
    const m = mkMgr();
    const a = m.download('test');
    const a2 = m.download('test');
    const b = m.download('us/test2');
    a.catch(() => undefined); b.catch(() => undefined);
    await waitFor(() => m.activeDownloads().length === 2);
    await expect(m.download('europe')).rejects.toThrow(/2 downloads are already running/);
    m.cancel();
    await Promise.allSettled([a, a2, b]);
  });

  it('HTTP errors and policy violations', async () => {
    beh.status = 404;
    await expect(mkMgr().download('test')).rejects.toThrow(/DOWNLOAD_FAILED: the server does not have this file \(HTTP 404\)/);
    beh.status = undefined;
    await expect(mkMgr().download('nope')).rejects.toThrow(/BAD_REQUEST: unknown region/);
    await expect(mkMgr().download('../x')).rejects.toThrow(/BAD_REQUEST/);
    const evil = createServer((_q, r) => { r.writeHead(302, { Location: 'http://example.invalid/x.osm.pbf' }); r.end(); });
    await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
    await expect(mkMgr().request(`http://127.0.0.1:${(evil.address() as AddressInfo).port}/x.osm.pbf`)).rejects.toThrow(/refusing to contact example.invalid/);
    evil.close();
  });

  it('server errors are retried then reported', async () => {
    beh.status = 503;
    await expect(mkMgr().download('test')).rejects.toThrow(/DOWNLOAD_FAILED: server busy \(HTTP 503\).*gave up/);
    expect(beh.requests).toBe(5);
  });

  it('a server that never sends headers is timed out (header timeout = stallMs) and retried', async () => {
    beh.hang = true;
    const t0 = Date.now();
    await expect(mkMgr({ stallMs: 120 }).download('test')).rejects.toThrow(/did not respond.*gave up/);
    expect(beh.requests).toBe(5);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('refuses to start without enough disk space', async () => {
    const m = mkMgr({ statfsFn: async () => ({ bavail: 10, bsize: 1024 }) });
    await expect(m.download('test')).rejects.toThrow(/not enough free disk space/);
    expect(existsSync(partPath())).toBe(false);
  });

  it('the free-space check accounts for other running downloads', async () => {
    beh.slowMs = 40;
    // room for exactly one file (plus 1 KB), not two
    const m = mkMgr({ freeMarginBytes: 0, statfsFn: async () => ({ bavail: DATA.length + 1024, bsize: 1 }) });
    const a = m.download('test');
    a.catch(() => undefined);
    await waitFor(() => events.some((x) => x.phase === 'download' && x.receivedBytes > 0));
    const b = m.download('us/test2');
    b.catch(() => undefined);
    await expect(b).rejects.toThrow(/not enough free disk space/);
    m.cancelAll();
    await Promise.allSettled([a]);
  });

  it('a stalled connection is aborted and resumed', async () => {
    const stall = createServer((req, res) => {
      if (req.url!.endsWith('.md5')) { res.writeHead(404); res.end(); return; }
      const mm = /bytes=(\d+)-/.exec(String(req.headers.range ?? ''));
      const start = mm ? Number(mm[1]) : 0;
      res.writeHead(start ? 206 : 200, { ETag: '"s"', 'Content-Length': DATA.length - start, ...(start ? { 'Content-Range': `bytes ${start}-${DATA.length - 1}/${DATA.length}` } : {}) });
      if (!start) { res.write(DATA.subarray(0, 50_000)); return; }
      res.end(DATA.subarray(start));
    });
    await new Promise<void>((r) => stall.listen(0, '127.0.0.1', r));
    const sb = `http://127.0.0.1:${(stall.address() as AddressInfo).port}`;
    writeFileSync(join(dir, 'index-v1.json'), JSON.stringify({ type: 'FeatureCollection', features: [feature('stall', undefined, `${sb}/stall.osm.pbf`, sq(0, 0, 1, 1))] }));
    writeFileSync(join(dir, 'index-v1.meta.json'), JSON.stringify({ fetchedAt: Date.now() }));
    const e = await mkMgr({ stallMs: 300 }).download('stall');
    expect(readFileSync(e.pbfPath).equals(DATA)).toBe(true);
    stall.closeAllConnections(); stall.close();
  });

  it('ignores inconsistent files on disk (size differs from sidecar) and tolerates sidecar-less pbf', async () => {
    const m = mkMgr();
    const e = await m.download('test');
    writeFileSync(e.pbfPath.replace('.osm.pbf', '.json'), JSON.stringify({ ...e, sizeBytes: 5 }));
    expect(await m.listEntries()).toEqual([]);
    rmSync(e.pbfPath.replace('.osm.pbf', '.json'));
    const l = await m.listEntries();
    expect(l.length).toBe(1);
    expect(l[0].verified).toBe(false);
  });
});
