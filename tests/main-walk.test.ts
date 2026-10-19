import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CH } from '../src/shared/channels';
import type { DetailParams, DetailStats, GenerateParams, GenerateStats, WalkEntrance, WorldMeta } from '../src/shared/contract';
import { normaliseDetail, WorldStore } from '../src/main/worlds';
import { applyCityFrame, sanitizeEntrances, validateDetailStats } from '../src/main/validate';
import {
  authorize, cleanSpawn, resolveSender, LOCKED_WHILE_WALKING, MAIN_ONLY, prepareWalk, WALK_ALLOWED, WalkManager, type WalkWindowHandle,
} from '../src/main/walk';

const ent = (o: Partial<WalkEntrance> = {}): WalkEntrance => ({
  edge: 0, city: [10, 1, 20], cityDir: [0, 1], inside: [1, 0, 2], outside: [1, 0, 3], dir: [0, -1], widthM: 1.1, ...o,
});
const bbox = { latMin: 48.8575, lonMin: 2.2935, latMax: 48.8595, lonMax: 2.2965 };
const gp = (): GenerateParams => ({
  bbox, voxelSize: 2, features: { roads: true, elevation: true, proceduralFacades: true },
  metersPerFloor: 3.5, defaultBuildingHeight: 10.5, maxVoxels: 1_000_000,
});
const gstats = (n = 3): GenerateStats => ({ voxelCount: n, buildingCount: 1, buildingsWithPhotos: 0, buildingsProcedural: 1, elapsedMs: 5 });
const base: DetailStats = { voxelCount: 3, levels: 1, rooms: 1, windows: 0, doors: 1, elapsedMs: 1, floorYs: [0] };
const dp = (): DetailParams => ({ ref: { bbox, buildingId: 'way/1' }, voxelSize: 0.15, maxVoxels: 1000 });

describe('walk: sender allow-list', () => {
  const walkOk = [CH.readVwg, CH.readBuildingIndex, CH.openDetail, CH.listDetails, CH.detail, CH.cancel, CH.walkSession, CH.endWalk];

  it('the walk window may call exactly its allow-list', () => {
    for (const c of walkOk) expect(() => authorize(c, 'walk', true), c).not.toThrow();
    for (const c of Object.values(CH)) {
      if (walkOk.includes(c as never) || c === CH.walkActive) continue;
      expect(() => authorize(c, 'walk', true), c).toThrow(/^BAD_REQUEST/);
    }
  });
  it.each([CH.generate, CH.exportAs, CH.deleteWorld, CH.openWorld, CH.renameWorld, CH.downloadGeodata, CH.deleteGeodata, CH.pickPhoto, CH.analyzeFacade, CH.startWalk, CH.deleteDetail])(
    'walk window cannot call %s',
    (c) => expect(() => authorize(c, 'walk', true)).toThrow(/BAD_REQUEST/),
  );
  it('a walk sender is rejected outright once no walk is active', () => {
    expect(() => authorize(CH.readVwg, 'walk', false)).toThrow(/BAD_REQUEST/);
  });
  it('walkSession / endWalk are walk-only', () => {
    expect(() => authorize(CH.walkSession, 'main', false)).toThrow(/BAD_REQUEST/);
    expect(() => authorize(CH.endWalk, 'main', true)).toThrow(/BAD_REQUEST/);
  });
  it('the locked main window cannot start jobs or change the library, but can read and unlock', () => {
    for (const c of LOCKED_WHILE_WALKING) expect(() => authorize(c, 'main', true), c).toThrow(/^BUSY/);
    for (const c of [CH.listWorlds, CH.readVwg, CH.readBuildingIndex, CH.walkActive, CH.walkFocus, CH.walkExit]) {
      expect(() => authorize(c, 'main', true), c).not.toThrow();
    }
  });
  it('without a walk the main window is unrestricted (except walk-only channels)', () => {
    for (const c of [CH.generate, CH.detail, CH.exportAs, CH.openWorld, CH.deleteWorld, CH.startWalk, CH.cancel]) expect(() => authorize(c, 'main', false)).not.toThrow();
  });
  it('main-only channels are never in the walk allow-list', () => {
    for (const c of MAIN_ONLY) expect(WALK_ALLOWED.has(c)).toBe(false);
  });
});

function harness() {
  const events: string[] = [];
  const handle = (id: number): WalkWindowHandle & { onGone: (r: string) => void } => {
    const h = {
      id,
      onGone: (_r: string) => undefined,
      focus: vi.fn(),
      send: vi.fn(),
      close: vi.fn(() => { events.push('close'); h.onGone('closed'); }), // real window: close() -> 'closed' -> onGone
      destroy: vi.fn(),
    };
    return h;
  };
  let last: ReturnType<typeof handle> | null = null;
  const deps = {
    open: vi.fn((_s, onGone: (r: string) => void) => {
      last = handle(42);
      last.onGone = onGone;
      return last;
    }),
    broadcast: vi.fn((a: boolean) => events.push(`state:${a}`)),
    refocusMain: vi.fn(() => events.push('refocus')),
    releaseJob: vi.fn(() => events.push('release')),
  };
  return { deps, events, win: () => last!, mgr: new WalkManager(deps) };
}
const session = { world: { id: 'w' } as WorldMeta, vwgPath: '/x.vwg', buildingIndexPath: '' };

describe('walk: WalkManager', () => {
  it('begin broadcasts true, identifies the walk sender, and refuses a second walk with BUSY', () => {
    const { mgr, deps } = harness();
    expect(mgr.active).toBe(false);
    mgr.begin(session);
    expect(mgr.active).toBe(true);
    expect(mgr.isWalkSender(42)).toBe(true);
    expect(mgr.isWalkSender(7)).toBe(false);
    expect(deps.broadcast).toHaveBeenLastCalledWith(true);
    expect(() => mgr.begin(session)).toThrow(/^BUSY/);
    expect(deps.open).toHaveBeenCalledTimes(1);
  });
  it('a failing window creation leaves no walk active and broadcasts nothing', () => {
    const { mgr, deps } = harness();
    deps.open.mockImplementationOnce(() => { throw new Error('INTERNAL: no window'); });
    expect(() => mgr.begin(session)).toThrow(/no window/);
    expect(mgr.active).toBe(false);
    expect(deps.broadcast).not.toHaveBeenCalled();
    mgr.begin(session); // can start again
    expect(mgr.active).toBe(true);
  });
  it('end: releases the job slot, closes, broadcasts false, refocuses main, in that order, exactly once', () => {
    const { mgr, deps, events, win } = harness();
    mgr.begin(session);
    events.length = 0;
    mgr.end('endWalk');
    mgr.end('again');
    expect(events).toEqual(['release', 'close', 'state:false', 'refocus']);
    expect(deps.broadcast).toHaveBeenCalledTimes(2); // true, false
    expect(win().destroy).toHaveBeenCalled();
    expect(mgr.active).toBe(false);
    expect(mgr.isWalkSender(42)).toBe(false);
  });
  it('window closed by the user / renderer crash (onGone) ends the walk the same way', () => {
    for (const reason of ['closed', 'render-process-gone: crashed', 'load failed']) {
      const { mgr, deps, win } = harness();
      mgr.begin(session);
      win().onGone(reason);
      expect(mgr.active).toBe(false);
      expect(deps.releaseJob).toHaveBeenCalledTimes(1);
      expect(deps.broadcast).toHaveBeenLastCalledWith(false);
      expect(deps.refocusMain).toHaveBeenCalledTimes(1);
    }
  });
  it('cleanup survives a throwing releaseJob / close and still unlocks the app', () => {
    const { mgr, deps, win } = harness();
    mgr.begin(session);
    deps.releaseJob.mockImplementation(() => { throw new Error('x'); });
    win().close.mockImplementation(() => { throw new Error('gone'); });
    mgr.end();
    expect(deps.broadcast).toHaveBeenLastCalledWith(false);
    expect(deps.refocusMain).toHaveBeenCalled();
    expect(mgr.active).toBe(false);
  });
  it('a new walk can start after the previous one ended', () => {
    const { mgr } = harness();
    mgr.begin(session);
    mgr.end();
    expect(() => mgr.begin(session)).not.toThrow();
  });
  it('send / focus go to the walk window only while it exists', () => {
    const { mgr, win } = harness();
    mgr.send('a', 1);
    mgr.begin(session);
    mgr.send(CH.progress, { pct: 1 });
    mgr.focus();
    expect(win().send).toHaveBeenCalledWith(CH.progress, { pct: 1 });
    expect(win().focus).toHaveBeenCalled();
  });
});

describe('walk: startWalk validation (prepareWalk)', () => {
  const meta = (n: number): WorldMeta => ({ id: 'abcdefgh-1', stats: gstats(n) } as WorldMeta);
  const mk = (o: { busy?: string; n?: number; exists?: boolean } = {}) => ({
    isValid: (id: unknown) => typeof id === 'string' && /^[a-z0-9-]{8,}$/.test(id),
    has: () => o.exists !== false,
    busyReason: () => o.busy ?? '',
    open: vi.fn(async (_id: string, inSlot: (w: { meta: WorldMeta; vwgPath: string; buildingIndexPath?: string }) => void) => {
      inSlot({ meta: meta(o.n ?? 5), vwgPath: '/lib/w/world.vwg', buildingIndexPath: '/lib/w/world.buildings.json' });
      return null;
    }),
  });

  it('builds the session from the library; spawn passes through', async () => {
    const d = mk();
    const s = await prepareWalk(d, 'abcdefgh-1', { x: 3, z: -4 });
    expect(s).toMatchObject({ vwgPath: '/lib/w/world.vwg', buildingIndexPath: '/lib/w/world.buildings.json', spawn: { x: 3, z: -4 } });
    expect(s.world.id).toBe('abcdefgh-1');
  });
  it('no spawn: key is absent; no index: empty string', async () => {
    const d = mk();
    d.open.mockImplementation(async (_id, inSlot) => { inSlot({ meta: meta(5), vwgPath: '/v' }); return null; });
    const s = await prepareWalk(d, 'abcdefgh-1', undefined);
    expect('spawn' in s).toBe(false);
    expect(s.buildingIndexPath).toBe('');
  });
  it('BAD_REQUEST for ids that are not ids, WORLD_NOT_FOUND for unknown worlds', async () => {
    await expect(prepareWalk(mk(), '../x', undefined)).rejects.toThrow(/^BAD_REQUEST/);
    await expect(prepareWalk(mk(), 5, undefined)).rejects.toThrow(/^BAD_REQUEST/);
    await expect(prepareWalk(mk({ exists: false }), 'abcdefgh-1', undefined)).rejects.toThrow(/^WORLD_NOT_FOUND/);
  });
  it('BUSY while a job runs or a walk is open (files are not even opened)', async () => {
    const d = mk({ busy: 'a job is running' });
    await expect(prepareWalk(d, 'abcdefgh-1', undefined)).rejects.toThrow(/^BUSY: a job/);
    expect(d.open).not.toHaveBeenCalled();
  });
  it('BUSY when the state changed while the library was being read', async () => {
    const d = mk();
    let n = 0;
    d.busyReason = () => (++n > 1 ? 'a walking view is already open' : '');
    await expect(prepareWalk(d, 'abcdefgh-1', undefined)).rejects.toThrow(/^BUSY/);
  });
  it('NO_DATA for a world without voxels', async () => {
    await expect(prepareWalk(mk({ n: 0 }), 'abcdefgh-1', undefined)).rejects.toThrow(/^NO_DATA/);
  });
  it('bad spawns are BAD_REQUEST', () => {
    for (const bad of [{ x: NaN, z: 0 }, { x: 'a', z: 0 }, { x: 0 }, { x: 1e12, z: 0 }, 'x']) expect(() => cleanSpawn(bad)).toThrow(/^BAD_REQUEST/);
    expect(cleanSpawn(undefined)).toBeUndefined();
    expect(cleanSpawn({ x: 1.5, z: 2, extra: 1 })).toEqual({ x: 1.5, z: 2 });
  });
});

describe('detail ref city frame', () => {
  it('fills from the library and overrides renderer values', () => {
    const r = applyCityFrame({ buildingId: 'a', cityVoxelSize: 99, cityBaseY: 99 }, 0.5, 7);
    expect(r).toMatchObject({ buildingId: 'a', cityVoxelSize: 0.5, cityBaseY: 7 });
  });
  it('missing building: baseY dropped (python then reports BUILDING_NOT_FOUND as before); no world: both dropped', () => {
    const r = applyCityFrame({ buildingId: 'a', cityBaseY: 99, cityVoxelSize: 3 }, 0.5, undefined);
    expect(r.cityVoxelSize).toBe(0.5);
    expect('cityBaseY' in r).toBe(false);
    const n = applyCityFrame({ buildingId: 'a', cityBaseY: 99, cityVoxelSize: 3 });
    expect('cityBaseY' in n || 'cityVoxelSize' in n).toBe(false);
    expect('cityVoxelSize' in applyCityFrame({ buildingId: 'a' }, NaN, NaN)).toBe(false);
  });
  it('WorldStore.buildingBaseY reads the index', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'vw-bb-'));
    try {
      const f = (n: string, c: string): string => { const p = join(tmp, n); writeFileSync(p, c); return p; };
      const s = new WorldStore(join(tmp, 'w'));
      const w = await s.saveWorld({ params: gp(), stats: gstats(), vwgPath: f('a.vwg', 'VWG1'), buildingIndexPath: f('i.json', JSON.stringify({ version: 1, buildings: [{ id: 'way/1', baseY: 4 }] })) });
      expect(await s.buildingBaseY(w.meta.id, 'way/1')).toBe(4);
      expect(await s.buildingBaseY(w.meta.id, 'way/2')).toBeUndefined();
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('walk: DetailStats.entrances survive the library', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vw-walk-')); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('sanitizeEntrances keeps valid entries and drops malformed ones', () => {
    expect(sanitizeEntrances(undefined)).toBeUndefined();
    expect(sanitizeEntrances('x')).toBeUndefined();
    expect(sanitizeEntrances([])).toEqual([]);
    const good = ent();
    const out = sanitizeEntrances([
      good, null, 5, ent({ widthM: 0.5 }), ent({ cityDir: [2, 2] }), ent({ edge: -1 }),
      { ...good, inside: [1, NaN, 2] }, { ...good, city: [1, 2] }, ent({ edge: 3 }),
    ])!;
    expect(out).toEqual([good, ent({ edge: 3 })]);
  });
  it('is capped', () => {
    expect(sanitizeEntrances(Array.from({ length: 500 }, () => ent()))!.length).toBe(64);
  });
  it('normaliseDetail keeps entrances; legacy details without them load and stay without', () => {
    const rec = (stats: unknown) => ({ id: 'detail-id-1', worldId: 'world-id-12', buildingId: 'way/1', createdAt: '2026-01-01T00:00:00Z', voxelSize: 0.15, interior: true, stats, sizeBytes: 10 });
    const withEnt = normaliseDetail(rec({ ...base, entrances: [ent()] }), 'world-id-12', 'detail-id-1')!;
    expect(withEnt.record.stats.entrances).toEqual([ent()]);
    const legacy = normaliseDetail(rec(base), 'world-id-12', 'detail-id-1')!;
    expect('entrances' in legacy.record.stats).toBe(false);
    expect(legacy.record.stats.floorYs).toEqual([0]);
    const junk = normaliseDetail(rec({ ...base, entrances: 'nope' }), 'world-id-12', 'detail-id-1')!;
    expect('entrances' in junk.record.stats).toBe(false);
  });
  it('validateDetailStats still accepts stats with or without entrances', () => {
    expect(() => validateDetailStats(base)).not.toThrow();
    expect(() => validateDetailStats({ ...base, entrances: [ent()] })).not.toThrow();
  });
  it('round trip through the store (saveDetail -> disk -> fresh store -> list/openDetail)', async () => {
    const root = join(tmp, 'worlds');
    const src = join(tmp, 'src');
    mkdirSync(src);
    const f = (n: string): string => { const p = join(src, n); writeFileSync(p, 'VWG1data'); return p; };
    const s = new WorldStore(root);
    const w = await s.saveWorld({ params: gp(), stats: gstats(), vwgPath: f('a.vwg') });
    const d = await s.saveDetail({ worldId: w.meta.id, params: dp(), stats: { ...base, entrances: [ent()] }, vwgPath: f('d.vwg') });
    expect(d.record.stats.entrances).toEqual([ent()]);
    expect(JSON.parse(readFileSync(join(root, w.meta.id, 'details', `${d.record.id}.json`), 'utf8')).stats.entrances).toEqual([ent()]);
    const fresh = new WorldStore(root);
    const [again] = await fresh.list();
    expect(again!.details[0]!.stats.entrances).toEqual([ent()]);
    expect((await fresh.openDetail(w.meta.id, d.record.id)).record.stats.entrances).toEqual([ent()]);
  });
});

// ── onWalkState semantics (preload) ──
describe('walk: onWalkState (preload)', () => {
  type L = (e: unknown, p: unknown) => void;
  let listeners: Map<string, Set<L>>;
  let activeNow: boolean;
  let exposed: Record<string, any>;
  let invokeGate: Promise<void> | null;

  const load = async (): Promise<void> => {
    vi.resetModules();
    listeners = new Map();
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: (_k: string, api: unknown) => { exposed = api as Record<string, any>; } },
      ipcRenderer: {
        on: (c: string, l: L) => { (listeners.get(c) ?? listeners.set(c, new Set()).get(c)!).add(l); },
        removeListener: (c: string, l: L) => { listeners.get(c)?.delete(l); },
        invoke: async (c: string) => {
          if (invokeGate) await invokeGate;
          if (c === CH.walkActive) return activeNow;
          if (c === CH.endWalk) return { __voxelError: 'BAD_REQUEST: nope' };
          return undefined;
        },
      },
    }));
    await import('../src/preload/index');
  };
  const emit = (a: boolean): void => listeners.get(CH.walkState)?.forEach((l) => l({}, a));
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  beforeEach(() => { invokeGate = null; activeNow = false; });

  it('fires immediately with the current value, then on every change', async () => {
    activeNow = true;
    await load();
    const seen: boolean[] = [];
    exposed.onWalkState((a: boolean) => seen.push(a));
    await tick();
    expect(seen).toEqual([true]);
    emit(false);
    emit(true);
    expect(seen).toEqual([true, false, true]);
  });
  it('an event that beats the initial query wins (no stale overwrite)', async () => {
    activeNow = false; // stale answer
    let release!: () => void;
    invokeGate = new Promise((r) => { release = r; });
    await load();
    const seen: boolean[] = [];
    exposed.onWalkState((a: boolean) => seen.push(a));
    emit(true);
    release();
    await tick();
    expect(seen).toEqual([true]);
  });
  it('unsubscribe stops delivery; errors surface as clean CODE: message', async () => {
    await load();
    const seen: boolean[] = [];
    const off = exposed.onWalkState((a: boolean) => seen.push(a));
    await tick();
    off();
    emit(true);
    expect(seen).toEqual([false]);
    await expect(exposed.endWalk()).rejects.toThrow('BAD_REQUEST: nope');
  });
});

describe('walk: sender-kind resolution', () => {
  it('main / walk / unknown / sub-frame', () => {
    expect(resolveSender(1, true, 1, 2)).toBe('main');
    expect(resolveSender(2, true, 1, 2)).toBe('walk');
    expect(resolveSender(1, undefined, 1, undefined)).toBe('main');
    expect(() => resolveSender(3, true, 1, 2)).toThrow(/unknown caller/);
    expect(() => resolveSender(2, true, 1, undefined)).toThrow(/unknown caller/); // a closed walk window is nobody
    expect(() => resolveSender(1, false, 1, 2)).toThrow(/unexpected caller/);
    expect(() => resolveSender(2, false, 1, 2)).toThrow(/unexpected caller/);
    expect(() => resolveSender(1, true, undefined, undefined)).toThrow(/unknown caller/);
  });
});

describe('walk: serialised with library mutations', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vw-walkq-')); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const setup = async () => {
    const f = join(tmp, 'a.vwg');
    writeFileSync(f, 'VWG1data');
    const store = new WorldStore(join(tmp, 'w'));
    const w = await store.saveWorld({ params: gp(), stats: gstats(), vwgPath: f });
    let walking = false;
    const deps = {
      isValid: (id: unknown) => typeof id === 'string',
      has: (id: string) => store.has(id),
      busyReason: () => (walking ? 'a walking view is already open' : ''),
      open: (id: string, inSlot: Parameters<WorldStore['open']>[1]) => store.open(id, inSlot),
    };
    const noWalk = (): void => { if (walking) throw new Error('BUSY: the walking view is open'); };
    return { store, id: w.meta.id, deps, begin: () => { walking = true; }, noWalk };
  };
  it('delete queued before the walk: the walk fails with WORLD_NOT_FOUND', async () => {
    const { store, id, deps, begin, noWalk } = await setup();
    const del = store.deleteWorld(id, noWalk);
    const walk = prepareWalk(deps, id, undefined, begin);
    await del;
    await expect(walk).rejects.toThrow(/WORLD_NOT_FOUND/);
  });
  it('walk queued before the delete: the delete is refused and the world survives', async () => {
    const { store, id, deps, begin, noWalk } = await setup();
    const walk = prepareWalk(deps, id, undefined, begin);
    const del = store.deleteWorld(id, noWalk);
    const ren = store.rename(id, 'x', noWalk);
    await walk;
    await expect(del).rejects.toThrow(/BUSY/);
    await expect(ren).rejects.toThrow(/BUSY/);
    expect(store.has(id)).toBe(true);
  });
});
