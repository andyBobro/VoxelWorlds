import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, truncateSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DetailParams, DetailStats, GenerateParams, GenerateStats } from '../src/shared/contract';
import { cleanWorldName, defaultWorldName, detailIdFor, isValidId, normaliseMeta, normaliseParams, sanitizeParams, WorldStore } from '../src/main/worlds';
import { isRegionId, sourceKey, validateDetail, validateGenerate } from '../src/main/validate';
import { copyFileAtomic, dirSize, fsyncDir, isInside, SerialQueue, sleep, writeFileAtomic } from '../src/main/fsutil';
import { multiPolyCoversBBox, type Poly } from '../src/main/geometry';
import { errText } from '../src/main/errors';
import { BridgeError } from '../src/main/pythonBridge';

const bbox = { latMin: 48.8575, lonMin: 2.2935, latMax: 48.8595, lonMax: 2.2965 };
const gp = (o: Partial<GenerateParams> = {}): GenerateParams => ({
  bbox, voxelSize: 2, features: { roads: true, elevation: true, proceduralFacades: true },
  mapillaryToken: 'SECRET-TOKEN', metersPerFloor: 3.5, defaultBuildingHeight: 10.5, maxVoxels: 1_000_000, ...o,
});
const gstats: GenerateStats = { voxelCount: 3, buildingCount: 1, buildingsWithPhotos: 0, buildingsProcedural: 1, elapsedMs: 5, buildingIndexPath: '/tmp/vw-x.json' };
const dstats: DetailStats = { voxelCount: 3, levels: 1, rooms: 1, windows: 0, doors: 0, elapsedMs: 1, floorYs: [0] };
const dp = (o: Partial<DetailParams> = {}): DetailParams => ({ ref: { bbox, buildingId: 'way/1' }, voxelSize: 0.15, maxVoxels: 1000, ...o });
const NOID = '00000000-0000-0000-0000-000000000000';

let tmp: string, root: string, src: string;
let logs: string[];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vw-worlds-'));
  root = join(tmp, 'worlds');
  src = join(tmp, 'src');
  mkdirSync(src);
  logs = [];
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const mkSrc = (name: string, content = 'VWG1data'): string => {
  const p = join(src, name);
  writeFileSync(p, content);
  return p;
};

describe('pure helpers', () => {
  it('id validation rejects traversal and junk', () => {
    expect(isValidId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '.hidden-id-xx', 'short', 'UPPERCASE-ID-1234', 'x'.repeat(65), 5, null, undefined]) {
      expect(isValidId(bad)).toBe(false);
    }
  });
  it('region ids', () => {
    for (const ok of ['monaco', 'us/alabama', 'germany', 'great-britain']) expect(isRegionId(ok)).toBe(true);
    for (const bad of ['', '..', '../x', 'a/../b', '/abs', 'a//b', '.x', 'a/.b', 'A', 'a b', 'a\\b']) expect(isRegionId(bad)).toBe(false);
  });
  it('sanitizeParams drops the token and the pbf path', () => {
    const p = sanitizeParams(gp({ dataSource: { kind: 'pbf', regionId: 'monaco', pbfPath: '/secret/x.pbf' } }));
    expect(JSON.stringify(p)).not.toMatch(/SECRET|pbfPath|secret/);
    expect(p.dataSource).toEqual({ kind: 'pbf', regionId: 'monaco' });
  });
  it('normaliseParams repairs garbage without throwing and whitelists fields', () => {
    const p = normaliseParams({ features: 5, maxVoxels: -3, metersPerFloor: 'x', defaultBuildingHeight: 1e9, dataSource: { kind: 'pbf' }, evil: 1, workers: 99, tileSize: 10 }, bbox, 2);
    expect(p).toEqual({
      bbox, voxelSize: 2, features: { roads: true, elevation: true, proceduralFacades: true },
      metersPerFloor: 3.5, defaultBuildingHeight: 10.5, maxVoxels: 20_000_000, dataSource: { kind: 'overpass' },
    });
    expect(() => normaliseParams(undefined, bbox, 1)).not.toThrow();
    expect(() => normaliseParams(null, bbox, 1)).not.toThrow();
  });
  it('default name and rename cleaning', () => {
    expect(defaultWorldName(bbox, new Date(2026, 9, 17, 9, 5))).toBe('48.8585,2.2950 2026-10-17 09:05 · Overpass');
    expect(defaultWorldName(bbox, new Date(2026, 9, 17, 23, 59), 'Monaco')).toBe('48.8585,2.2950 2026-10-17 23:59 · Monaco');
    expect(cleanWorldName('  a \n b  ')).toBe('a b');
    expect(() => cleanWorldName('   ')).toThrow(/BAD_REQUEST/);
    expect(() => cleanWorldName('x'.repeat(121))).toThrow();
    expect(() => cleanWorldName(5)).toThrow();
  });
  it('detail id is deterministic, ignores maxVoxels and worldId, differs by options', () => {
    const a = detailIdFor(dp());
    expect(isValidId(a)).toBe(true);
    expect(detailIdFor(dp({ maxVoxels: 5 }))).toBe(a);
    expect(detailIdFor(dp({ worldId: NOID }))).toBe(a);
    expect(detailIdFor(dp({ interior: { enabled: false } }))).toBe(a);
    expect(detailIdFor(dp({ interior: { enabled: true } }))).not.toBe(a);
    expect(detailIdFor(dp({ voxelSize: 0.2 }))).not.toBe(a);
    expect(detailIdFor(dp({ ref: { bbox, buildingId: 'way/2' } }))).not.toBe(a);
    expect(detailIdFor(dp({ interior: { enabled: true, seed: 1, roomMinM: 3 } }))).toBe(detailIdFor(dp({ interior: { roomMinM: 3, seed: 1, enabled: true } })));
  });
  it('errText only passes known codes through', () => {
    expect(errText(new Error('BAD_REQUEST: nope'))).toBe('BAD_REQUEST: nope');
    expect(errText(new Error('BUSY: wait'))).toBe('BUSY: wait');
    expect(errText(new BridgeError('NO_DATA', 'empty'))).toBe('NO_DATA: empty');
    expect(errText(new Error("ENOENT: no such file or directory, open '/Users/x/secret'"))).toMatch(/^INTERNAL: ENOENT/);
    expect(errText(new Error('plain'))).toBe('INTERNAL: plain');
    expect(errText('str')).toBe('INTERNAL: str');
  });
});

describe('validators', () => {
  const last = { bbox, dataSource: { kind: 'pbf', regionId: 'monaco' } as const };
  it('detail needs same bbox and same data source kind/regionId', () => {
    const okRef = dp({ ref: { bbox, buildingId: 'way/1', dataSource: { kind: 'pbf', regionId: 'monaco', pbfPath: '/ignored' } } });
    expect(() => validateDetail(okRef, last)).not.toThrow();
    expect(() => validateDetail(dp(), last)).toThrow(/dataSource/);
    expect(() => validateDetail(dp({ ref: { bbox, buildingId: 'way/1', dataSource: { kind: 'pbf', regionId: 'other' } } }), last)).toThrow(/dataSource/);
    expect(() => validateDetail(dp({ ref: { bbox, buildingId: 'way/1', dataSource: { kind: 'overpass' } } }), last)).toThrow(/dataSource/);
    expect(() => validateDetail(dp(), { bbox })).not.toThrow();
    expect(() => validateDetail(dp(), { bbox: { ...bbox, latMin: 1 } })).toThrow(/bbox/);
    expect(() => validateDetail(dp(), null)).toThrow(/BAD_REQUEST/);
  });
  it('generate: data source shape and whitelisted fields; undefined params is BAD_REQUEST, not TypeError', () => {
    expect(() => validateGenerate(gp({ dataSource: { kind: 'pbf', regionId: '../etc' } }))).toThrow(/regionId/);
    expect(() => validateGenerate(gp({ dataSource: { kind: 'zip' } as never }))).toThrow(/kind/);
    expect(() => validateGenerate(gp({ dataSource: { kind: 'pbf', regionId: 'us/alabama' } }))).not.toThrow();
    expect(() => validateGenerate(undefined as never)).toThrow(/^Error: BAD_REQUEST|BAD_REQUEST/);
    expect(() => validateGenerate(gp({ features: undefined as never }))).toThrow(/BAD_REQUEST: features/);
    expect(() => validateGenerate(gp({ features: { roads: 1 } as never }))).toThrow(/BAD_REQUEST/);
    expect(() => validateGenerate(gp({ maxVoxels: 0 }))).toThrow(/maxVoxels/);
    expect(() => validateGenerate(gp({ maxVoxels: 1.5 }))).toThrow(/maxVoxels/);
    expect(() => validateGenerate(gp({ metersPerFloor: 0 }))).toThrow(/metersPerFloor/);
    expect(() => validateGenerate(gp({ defaultBuildingHeight: NaN }))).toThrow(/defaultBuildingHeight/);
    expect(() => validateGenerate(gp({ mapillaryToken: 5 as never }))).toThrow(/mapillaryToken/);
    expect(() => validateGenerate(gp())).not.toThrow();
    expect(sourceKey(undefined)).toBe('overpass');
    expect(sourceKey({ kind: 'pbf', regionId: 'a', pbfPath: 'x' })).toBe('pbf:a');
  });
});

describe('fsutil', () => {
  it('writeFileAtomic replaces content and leaves no tmp files', async () => {
    const f = join(tmp, 'a.json');
    await writeFileAtomic(f, 'one');
    await writeFileAtomic(f, 'two');
    expect(readFileSync(f, 'utf8')).toBe('two');
    expect(readdirSync(tmp).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
  it('writeFileAtomic failure keeps the old file and cleans the tmp', async () => {
    const f = join(tmp, 'keep.txt');
    await writeFileAtomic(f, 'old');
    await expect(writeFileAtomic(join(tmp, 'missing-dir', 'x'), 'new')).rejects.toThrow();
    expect(readFileSync(f, 'utf8')).toBe('old');
  });
  it('copyFileAtomic overwrites, fails cleanly on a missing source', async () => {
    const dst = join(tmp, 'dst.bin');
    writeFileSync(dst, 'old');
    await copyFileAtomic(mkSrc('s.bin', 'newer'), dst);
    expect(readFileSync(dst, 'utf8')).toBe('newer');
    await expect(copyFileAtomic(join(src, 'nope'), join(tmp, 'd2'))).rejects.toThrow();
    expect(readdirSync(tmp).filter((n) => n.includes('.tmp-'))).toEqual([]);
    await expect(fsyncDir(tmp)).resolves.toBeUndefined();
    await expect(fsyncDir(join(tmp, 'nonexistent'))).resolves.toBeUndefined();
  });
  it('dirSize ignores tmp leftovers; isInside is lexical and strict', async () => {
    mkdirSync(join(tmp, 'd'));
    writeFileSync(join(tmp, 'd', 'a'), '12345');
    writeFileSync(join(tmp, 'd', 'b.tmp-1-x'), '999999');
    expect(await dirSize(join(tmp, 'd'))).toBe(5);
    expect(await dirSize(join(tmp, 'nope'))).toBe(0);
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a/b/../c')).toBe(false);
  });
  it('SerialQueue keeps order even when a task fails', async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    const a = q.run(async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); });
    const b = q.run(async () => { order.push(2); throw new Error('x'); });
    const c = q.run(async () => { order.push(3); });
    await a; await expect(b).rejects.toThrow(); await c;
    expect(order).toEqual([1, 2, 3]);
  });
  it('sleep is abortable', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = sleep(5000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    expect(await p).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await sleep(5)).toBe(true);
    expect(await sleep(5000, AbortSignal.abort())).toBe(false);
  });
});

describe('geometry union cover', () => {
  const sq = (a: number, b: number, c: number, d: number): Poly => [[[a, b], [c, b], [c, d], [a, d], [a, b]]];
  it('a bbox straddling the seam of two adjoining parts is covered; a gap is not', () => {
    const seam: Poly[] = [sq(0, 0, 5, 10), sq(5, 0, 10, 10)];
    expect(multiPolyCoversBBox(seam, { lonMin: 4, lonMax: 6.3, latMin: 2, latMax: 3 })).toBe(true);
    const gap: Poly[] = [sq(0, 0, 4.9, 10), sq(5.1, 0, 10, 10)];
    expect(multiPolyCoversBBox(gap, { lonMin: 4, lonMax: 6.3, latMin: 2, latMax: 3 })).toBe(false);
    expect(multiPolyCoversBBox(seam, { lonMin: 9, lonMax: 11, latMin: 2, latMax: 3 })).toBe(false);
  });
});

describe('WorldStore', () => {
  const mk = () => new WorldStore(root, (m) => logs.push(m));

  it('auto-saves a world: copies files, strips token and temp index path, writes formatVersion + byte sizes', async () => {
    const s = mk();
    const saved = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('a.vwg', 'x'.repeat(1000)), buildingIndexPath: mkSrc('a.json', '{"version":1,"buildings":[]}') });
    expect(isValidId(saved.meta.id)).toBe(true);
    expect(readFileSync(saved.vwgPath, 'utf8').length).toBe(1000);
    expect(saved.buildingIndexPath && existsSync(saved.buildingIndexPath)).toBe(true);
    expect(saved.meta.hasBuildingIndex).toBe(true);
    expect(saved.meta.formatVersion).toBe(1);
    expect(saved.meta.sizeBytes).toBeGreaterThanOrEqual(1000);
    const raw = readFileSync(join(root, saved.meta.id, 'meta.json'), 'utf8');
    expect(raw).not.toMatch(/SECRET|buildingIndexPath|\/tmp/);
    expect(JSON.parse(raw).files).toEqual({ vwgBytes: 1000, indexBytes: 28 });
    expect(saved.meta.name).toMatch(/^48\.8585,2\.2950 \d{4}-\d{2}-\d{2} \d{2}:\d{2} · Overpass$/);
    expect(readdirSync(root).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('survives a restart (re-scan) and sorts newest first', async () => {
    const s = mk();
    const a = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('a.vwg'), now: new Date('2026-01-01') });
    const b = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('b.vwg'), now: new Date('2026-02-01') });
    const list = await mk().list();
    expect(list.map((w) => w.id)).toEqual([b.meta.id, a.meta.id]);
    expect(list[0].hasBuildingIndex).toBe(false);
    expect(list[0].formatVersion).toBe(1);
  });

  it('skips corrupt / incomplete worlds and sweeps interrupted saves, without throwing', async () => {
    const s = mk();
    const good = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('a.vwg') });
    const goodMeta = readFileSync(join(root, good.meta.id, 'meta.json'));
    const badJson = join(root, '11111111-aaaa-bbbb-cccc-000000000001');
    mkdirSync(badJson); writeFileSync(join(badJson, 'meta.json'), '{not json'); writeFileSync(join(badJson, 'world.vwg'), 'x');
    const noVwg = join(root, '11111111-aaaa-bbbb-cccc-000000000002');
    mkdirSync(noVwg); writeFileSync(join(noVwg, 'meta.json'), goodMeta);
    const wrongId = join(root, '11111111-aaaa-bbbb-cccc-000000000003');
    mkdirSync(wrongId); writeFileSync(join(wrongId, 'meta.json'), goodMeta); writeFileSync(join(wrongId, 'world.vwg'), 'x');
    const emptyVwg = join(root, '11111111-aaaa-bbbb-cccc-000000000004');
    mkdirSync(emptyVwg); writeFileSync(join(emptyVwg, 'meta.json'), JSON.stringify({ ...JSON.parse(goodMeta.toString()), id: '11111111-aaaa-bbbb-cccc-000000000004' })); writeFileSync(join(emptyVwg, 'world.vwg'), '');
    mkdirSync(join(root, '.tmp-interrupted')); mkdirSync(join(root, 'not an id'));
    const list = await mk().list();
    expect(list.map((w) => w.id)).toEqual([good.meta.id]);
    expect(logs.filter((l) => /damaged|skipping/.test(l)).length).toBeGreaterThanOrEqual(5);
    expect(existsSync(join(root, '.tmp-interrupted'))).toBe(false);
    // damaged worlds are quarantined, not deleted and not listed again
    expect(readdirSync(join(root, '.damaged')).length).toBe(4);
    expect(existsSync(badJson)).toBe(false);
    expect((await mk().list()).map((w) => w.id)).toEqual([good.meta.id]);
  });

  it('a truncated world.vwg or detail .vwg (size differs from the recorded one) is skipped', async () => {
    const s = mk();
    const w = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('a.vwg', 'x'.repeat(500)) });
    const w2 = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('b.vwg', 'y'.repeat(500)) });
    const d = await s.saveDetail({ worldId: w2.meta.id, params: dp(), stats: dstats, vwgPath: mkSrc('d.vwg', 'z'.repeat(300)) });
    truncateSync(w.vwgPath, 200);
    truncateSync(d.vwgPath, 100);
    const list = await mk().list();
    expect(list.map((x) => x.id)).toEqual([w2.meta.id]);
    expect(list[0].details).toEqual([]);
    expect(logs.some((l) => /truncated/.test(l))).toBe(true);
  });

  it('normalises legacy / partial metas instead of dropping or crashing', async () => {
    const s = mk();
    const w = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('a.vwg') });
    const mp = join(root, w.meta.id, 'meta.json');
    const legacy = { id: w.meta.id, name: 5, bbox, stats: { voxelCount: 'many' }, params: { features: null, maxVoxels: 'x', mapillaryToken: 'LEAK', dataSource: { kind: 'pbf', regionId: 'monaco', pbfPath: '/p' } }, sizeBytes: 'big' };
    writeFileSync(mp, JSON.stringify(legacy));
    const [m] = await mk().list();
    expect(m.formatVersion).toBe(1);
    expect(m.stats.voxelCount).toBe(0);
    expect(m.sizeBytes).toBe(0);
    expect(m.params.maxVoxels).toBe(20_000_000);
    expect(m.params.features).toEqual({ roads: true, elevation: true, proceduralFacades: true });
    expect(m.params.dataSource).toEqual({ kind: 'pbf', regionId: 'monaco' });
    expect(JSON.stringify(m)).not.toMatch(/LEAK|pbfPath/);
    expect(typeof m.name).toBe('string');
    expect(normaliseMeta({ id: 'x' }, 'x')).toBeNull();
    expect(normaliseMeta(null, 'x')).toBeNull();
  });

  it('failed save leaves nothing behind', async () => {
    const s = mk();
    await s.init();
    await expect(s.saveWorld({ params: gp(), stats: gstats, vwgPath: join(src, 'missing.vwg') })).rejects.toThrow();
    await expect(s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('empty.vwg', '') })).rejects.toThrow(/empty/);
    expect(readdirSync(root)).toEqual([]);
    expect(await s.list()).toEqual([]);
  });

  it('open / rename / delete validate ids and report WORLD_NOT_FOUND', async () => {
    const s = mk();
    const w = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('a.vwg') });
    await expect(s.open('../' + w.meta.id)).rejects.toThrow(/BAD_REQUEST/);
    await expect(s.open(NOID)).rejects.toThrow(/WORLD_NOT_FOUND/);
    const r = await s.rename(w.meta.id, '  My Paris ');
    expect(r.name).toBe('My Paris');
    expect((await mk().list())[0].name).toBe('My Paris');
    expect((await mk().list())[0].formatVersion).toBe(1);
    await s.deleteWorld(w.meta.id);
    expect(await s.list()).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
    await expect(s.deleteWorld(w.meta.id)).rejects.toThrow(/WORLD_NOT_FOUND/);
  });

  it('open drops a world whose vwg vanished or shrank', async () => {
    const s = mk();
    const w = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('a.vwg', 'x'.repeat(50)) });
    truncateSync(w.vwgPath, 10);
    await expect(s.open(w.meta.id)).rejects.toThrow(/WORLD_NOT_FOUND/);
    expect(await s.list()).toEqual([]);
  });

  it('saves details, overwrites the same options instead of duplicating, lists newest first, deletes', async () => {
    const s = mk();
    const w = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('a.vwg'), buildingIndexPath: mkSrc('i.json', JSON.stringify({ version: 1, buildings: [{ id: 'way/1', name: 'Tower' }] })) });
    expect(await s.buildingName(w.meta.id, 'way/1')).toBe('Tower');
    const d1 = await s.saveDetail({ worldId: w.meta.id, params: dp(), stats: dstats, vwgPath: mkSrc('d1.vwg', 'one'), now: new Date('2026-03-01') });
    const d2 = await s.saveDetail({ worldId: w.meta.id, params: dp({ interior: { enabled: true } }), stats: dstats, vwgPath: mkSrc('d2.vwg', 'two!'), now: new Date('2026-03-02') });
    expect(d1.record.id).not.toBe(d2.record.id);
    expect(d2.record.interior).toBe(true);
    const again = await s.saveDetail({ worldId: w.meta.id, params: dp({ maxVoxels: 77 }), stats: dstats, vwgPath: mkSrc('d3.vwg', 'three-newer'), now: new Date('2026-03-03') });
    expect(again.record.id).toBe(d1.record.id);
    const details = await s.listDetails(w.meta.id);
    expect(details.map((d) => d.id)).toEqual([d1.record.id, d2.record.id]);
    expect(readFileSync(again.vwgPath, 'utf8')).toBe('three-newer');
    expect(details[0].sizeBytes).toBe('three-newer'.length);
    expect(JSON.stringify(details)).not.toMatch(/vwgBytes/);
    expect(readdirSync(join(root, w.meta.id, 'details')).filter((n) => n.includes('.tmp-'))).toEqual([]);

    const w2 = (await mk().list())[0];
    expect(w2.details.length).toBe(2);
    expect(w2.sizeBytes).toBeGreaterThan(w.meta.sizeBytes);
    const od = await s.openDetail(w.meta.id, d2.record.id);
    expect(readFileSync(od.vwgPath, 'utf8')).toBe('two!');
    await expect(s.openDetail(w.meta.id, '../../x')).rejects.toThrow(/BAD_REQUEST/);
    await expect(s.openDetail(w.meta.id, 'deadbeef00000000')).rejects.toThrow(/WORLD_NOT_FOUND/);

    const after = await s.deleteDetail(w.meta.id, d1.record.id);
    expect(after.details.map((d) => d.id)).toEqual([d2.record.id]);
    expect(existsSync(join(root, w.meta.id, 'details', `${d1.record.id}.vwg`))).toBe(false);
    expect(after.sizeBytes).toBeLessThan(w2.sizeBytes);
  });

  it('a detail without its json (crash before commit), with a stale tmp, or with a missing vwg is ignored', async () => {
    const s = mk();
    const w = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('a.vwg') });
    const d = await s.saveDetail({ worldId: w.meta.id, params: dp(), stats: dstats, vwgPath: mkSrc('d.vwg') });
    const dir = join(root, w.meta.id, 'details');
    writeFileSync(join(dir, 'dorphan0000000000.vwg'), 'x');
    writeFileSync(join(dir, 'dnovwg00000000000.json'), JSON.stringify({ id: 'dnovwg00000000000', worldId: w.meta.id }));
    writeFileSync(join(dir, `${d.record.id}.json.tmp-1-ab`), 'half');
    const list = await mk().listDetails(w.meta.id);
    expect(list.map((x) => x.id)).toEqual([d.record.id]);
    expect(existsSync(join(dir, `${d.record.id}.json.tmp-1-ab`))).toBe(false);
  });

  it('delete-during-use: saving/opening/deleting details of a deleted world fails with WORLD_NOT_FOUND, others keep working', async () => {
    const s = mk();
    const a = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('a.vwg') });
    const b = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('b.vwg') });
    const d = await s.saveDetail({ worldId: a.meta.id, params: dp(), stats: dstats, vwgPath: mkSrc('d.vwg') });
    const pending = s.saveDetail({ worldId: a.meta.id, params: dp({ voxelSize: 0.2 }), stats: dstats, vwgPath: mkSrc('d2.vwg') });
    const del = s.deleteWorld(a.meta.id); // queued behind the save
    await pending;
    await del;
    expect(s.has(a.meta.id)).toBe(false);
    await expect(s.saveDetail({ worldId: a.meta.id, params: dp(), stats: dstats, vwgPath: mkSrc('d3.vwg') })).rejects.toThrow(/WORLD_NOT_FOUND/);
    await expect(s.openDetail(a.meta.id, d.record.id)).rejects.toThrow(/WORLD_NOT_FOUND/);
    await expect(s.listDetails(a.meta.id)).rejects.toThrow(/WORLD_NOT_FOUND/);
    await expect(s.deleteDetail(a.meta.id, d.record.id)).rejects.toThrow(/WORLD_NOT_FOUND/);
    const ok = await s.saveDetail({ worldId: b.meta.id, params: dp(), stats: dstats, vwgPath: mkSrc('d4.vwg') });
    expect(ok.record.worldId).toBe(b.meta.id);
    expect(readdirSync(root).sort()).toEqual([b.meta.id]);
  });

  it('idle() resolves after queued writes; concurrent saves are serialised', async () => {
    const s = mk();
    const ps = [1, 2, 3, 4].map((i) => s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc(`c${i}.vwg`, 'x'.repeat(i)) }));
    await s.idle();
    const ws = await Promise.all(ps);
    expect(new Set(ws.map((w) => w.meta.id)).size).toBe(4);
    expect((await s.list()).length).toBe(4);
  });

  it('detail with an explicit worldId is validated against THAT world (bbox + data source) and saved there', async () => {
    const s = mk();
    const other = { ...bbox, latMin: 10, latMax: 10.01, lonMin: 20, lonMax: 20.01 };
    const a = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('a.vwg') });
    const b = await s.saveWorld({ params: gp({ bbox: other, dataSource: { kind: 'pbf', regionId: 'monaco', pbfPath: '/x' } }), stats: gstats, vwgPath: mkSrc('b.vwg') });
    const against = (id: string) => s.get(id).then((m) => ({ bbox: m.bbox, dataSource: m.params.dataSource }));
    const awaitedB = await against(b.meta.id);
    const forB = dp({ worldId: b.meta.id, ref: { bbox: other, buildingId: 'way/9', dataSource: { kind: 'pbf', regionId: 'monaco' } } });
    expect(() => validateDetail(forB, null as never)).toThrow();
    expect(() => validateDetail(forB, awaitedB)).not.toThrow();
    // wrong world for these refs
    await expect(against(a.meta.id)).resolves.toBeTruthy();
    expect(() => validateDetail(forB, { bbox, dataSource: { kind: 'overpass' } })).toThrow(/bbox/);
    const saved = await s.saveDetail({ worldId: b.meta.id, params: forB, stats: dstats, vwgPath: mkSrc('d.vwg') });
    expect(saved.record.worldId).toBe(b.meta.id);
    expect((await s.listDetails(a.meta.id)).length).toBe(0);
    expect((await s.listDetails(b.meta.id)).length).toBe(1);
  });

  it('default world name uses the region name for pbf worlds', async () => {
    const s = mk();
    const w = await s.saveWorld({ params: gp({ dataSource: { kind: 'pbf', regionId: 'monaco' } }), stats: gstats, vwgPath: mkSrc('a.vwg'), sourceLabel: 'Monaco' });
    expect(w.meta.name).toMatch(/ · Monaco$/);
    const w2 = await s.saveWorld({ params: gp({ dataSource: { kind: 'pbf', regionId: 'monaco' } }), stats: gstats, vwgPath: mkSrc('b.vwg') });
    expect(w2.meta.name).toMatch(/ · monaco$/);
  });

  it('list() rescans the directory: picks up out-of-band worlds, drops vanished ones, reloads edited metas, keeps unchanged ones', async () => {
    const s = mk();
    const a = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('a.vwg') });
    expect((await s.list()).length).toBe(1);
    // out-of-band copy of the world dir under a new id
    const id2 = '22222222-aaaa-bbbb-cccc-000000000009';
    mkdirSync(join(root, id2));
    writeFileSync(join(root, id2, 'world.vwg'), readFileSync(a.vwgPath));
    const meta = JSON.parse(readFileSync(join(root, a.meta.id, 'meta.json'), 'utf8'));
    writeFileSync(join(root, id2, 'meta.json'), JSON.stringify({ ...meta, id: id2, name: 'Imported' }));
    let list = await s.list();
    expect(list.map((w) => w.name)).toContain('Imported');
    expect(list.length).toBe(2);
    // edited out-of-band
    const mp = join(root, id2, 'meta.json');
    writeFileSync(mp, JSON.stringify({ ...meta, id: id2, name: 'Edited' }));
    const future = new Date(Date.now() + 5000);
    utimesSync(mp, future, future);
    list = await s.list();
    expect(list.find((w) => w.id === id2)?.name).toBe('Edited');
    // vanished
    rmSync(join(root, id2), { recursive: true });
    list = await s.list();
    expect(list.map((w) => w.id)).toEqual([a.meta.id]);
    // in-process changes are visible through list()
    await s.rename(a.meta.id, 'Renamed');
    expect((await s.list())[0].name).toBe('Renamed');
    // open() finds an out-of-band world without a prior list()
    const id3 = '33333333-aaaa-bbbb-cccc-000000000009';
    mkdirSync(join(root, id3));
    writeFileSync(join(root, id3, 'world.vwg'), readFileSync(a.vwgPath));
    writeFileSync(join(root, id3, 'meta.json'), JSON.stringify({ ...meta, id: id3 }));
    expect((await s.open(id3)).meta.id).toBe(id3);
  });

  it('sweeps orphan tmp files / detail vwg older than 1 h, keeps fresh ones, and sweeps old .damaged entries', async () => {
    const s = mk();
    const w = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('a.vwg') });
    const d = await s.saveDetail({ worldId: w.meta.id, params: dp(), stats: dstats, vwgPath: mkSrc('d.vwg') });
    const dir = join(root, w.meta.id);
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    for (const f of [join(dir, 'meta.json.tmp-1-aa'), join(dir, 'details', 'doldorphan00000000.vwg')]) {
      writeFileSync(f, 'x'); utimesSync(f, old, old);
    }
    writeFileSync(join(dir, 'meta.json.tmp-2-bb'), 'fresh');
    writeFileSync(join(dir, 'details', 'dfreshorphan00000.vwg'), 'fresh');
    mkdirSync(join(root, '.damaged', 'oldworld'), { recursive: true });
    utimesSync(join(root, '.damaged', 'oldworld'), new Date(0), new Date(0));
    mkdirSync(join(root, '.damaged', 'newworld'), { recursive: true });
    const list = await mk().list();
    expect(list[0].details.map((x) => x.id)).toEqual([d.record.id]);
    expect(existsSync(join(dir, 'meta.json.tmp-1-aa'))).toBe(false);
    expect(existsSync(join(dir, 'details', 'doldorphan00000000.vwg'))).toBe(false);
    expect(existsSync(join(dir, 'meta.json.tmp-2-bb'))).toBe(true);
    expect(existsSync(join(dir, 'details', 'dfreshorphan00000.vwg'))).toBe(true);
    expect(existsSync(join(root, '.damaged', 'oldworld'))).toBe(false);
    expect(existsSync(join(root, '.damaged', 'newworld'))).toBe(true);
  });

  it('keeps sourceInfo (pbf worlds) through save, reload and normalisation', async () => {
    const s = mk();
    const w = await s.saveWorld({ params: gp({ dataSource: { kind: 'pbf', regionId: 'monaco' } }), stats: gstats, vwgPath: mkSrc('a.vwg'), sourceInfo: { sizeBytes: 692762, sourceDate: 'Fri, 16 Oct 2026 03:57:19 GMT' } });
    expect(w.meta.sourceInfo).toEqual({ sizeBytes: 692762, sourceDate: 'Fri, 16 Oct 2026 03:57:19 GMT' });
    expect((await mk().get(w.meta.id)).sourceInfo?.sizeBytes).toBe(692762);
    const plain = await s.saveWorld({ params: gp(), stats: gstats, vwgPath: mkSrc('b.vwg') });
    expect(plain.meta.sourceInfo).toBeUndefined();
    expect(normaliseMeta({ id: 'x', bbox, sourceInfo: { sizeBytes: 'big' } }, 'x')!.meta.sourceInfo).toBeUndefined();
  });
});
