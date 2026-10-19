/**
 * The walking client: loads the saved world, streams it around the player, runs first-person physics and moves the
 * player between the city and building interiors. DOM/Three glue only; the logic lives in the pure modules
 * (physics, streaming, entrances, spawn, chunkStore) so it is unit-tested without a GPU.
 */
import * as THREE from 'three';
import { parseVwg } from '../../shared/vwg';
import type { BuildingInfo, DetailRecord, DetailStats, WalkEntrance, WalkSession } from '../../shared/contract';
import { estimateDetailVoxels } from '../detail/spec';
import { buildLinearPalette, buildChunkStoreAsync, yieldToUi, type ChunkStore } from './chunkStore';
import {
  BuildingGrid, collectSavedEntrances, crossedDoor, entranceCityMetres, entranceInBounds, findDoorCandidate, findEntrance,
  interiorEligibility, nearestEntrance, triggerConfig, type SavedEntrance,
} from './entrances';
import { planDetailBudget, planWalkBudget, type WalkBudget } from './budget';
import { Controls } from './controls';
import { GlHost } from './glhost';
import { buildingLabel, errorText, explainInteriorError, storeyAt } from './messages';
import { EYE_HEIGHT, Mover, scaleFromCityVoxel } from './physics';
import { boxFits, findSpawn, snapDoorCell } from './spawn';
import { GroupStreamer } from './streamer';
import { buildGroupTable, type GroupTable } from './streaming';
import { WalkUi } from './ui';
import { peekVoxelCount } from '../preview/budget';

const SKY = 0xbcd6ec;
const SKY_TOP = '#5f95cf';
const HAZE = 0xaab8c6;
const CITY_SPEEDS = { walk: 5, run: 12 };
const INDOOR_SPEEDS = { walk: 3, run: 6 };
const INTERIOR_VOXEL = 0.15;

type State = 'loading' | 'playing' | 'paused' | 'transition' | 'generating' | 'fatal';

interface Kit {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  fill: THREE.DirectionalLight | null;
  fog: THREE.Fog;
}

interface WorldCtx {
  store: ChunkStore;
  table: GroupTable;
  streamer: GroupStreamer;
  kit: Kit;
  budget: WalkBudget;
  limits: { rMin: number; rMax: number; maxTriangles: number; maxBytes: number };
}

interface DetailCtx extends WorldCtx {
  entrances: WalkEntrance[];
  floorYs: number[];
  stats: DetailStats;
  buildingId: string;
  name: string;
}

const nextFrame = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));

/** Reads a .vwg and re-buckets it into a ChunkStore; the raw buffer is unreachable when this returns. */
async function loadStore(path: string, onStage: (text: string, f: number | null) => void): Promise<{ store: ChunkStore; voxels: number; bytes: number }> {
  onStage('Reading voxels from disk', null);
  const buf = await window.voxel.readVwg(path);
  const voxels = peekVoxelCount(buf);
  const bytes = buf.byteLength;
  onStage('Parsing', null);
  await yieldToUi();
  const data = parseVwg(buf);
  const palette = buildLinearPalette(data.header.palette);
  const store = await buildChunkStoreAsync(data, palette, (f) => onStage('Indexing voxels', f));
  return { store, voxels, bytes };
}

export class WalkGame {
  private ui!: WalkUi;
  private controls!: Controls;
  private glh!: GlHost;
  private camera = new THREE.PerspectiveCamera(72, 1, 0.08, 2000);
  private material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private session!: WalkSession;
  private city!: WorldCtx;
  private detail: DetailCtx | null = null;
  private cur!: WorldCtx;
  private mover!: Mover;
  private state: State = 'loading';
  private mode: 'city' | 'detail' = 'city';
  private degrade = 0;
  private voxels = 0;
  private details: DetailRecord[] = [];
  private saved: SavedEntrance[] = [];
  private noEntrance = new Map<string, string>();
  private failed = new Map<string, { text: string; tech: string }>();
  private buildings: BuildingInfo[] = [];
  private grid: BuildingGrid | null = null;
  private eligible = new Map<string, boolean>();
  private cooldown = 0;
  private raf = 0;
  private last = performance.now();
  private disposed = false;
  private eyeY = 0;
  private haveEye = false;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fps = 0;
  private hudT = 0;
  private frameMs = 16;
  private showStats = false;
  private firstRun = true;
  /** probe on the city grid for door placement tests (never moves the player) */
  private cityProbe!: Mover;
  /** where the city pose was when a building was entered (recovery after a failed transition) */
  private cityReturn: [number, number, number] = [0, 0, 0];
  private byId = new Map<string, BuildingInfo>();
  /** where to put the player when they end up somewhere impossible: city spawn / detail door */
  private citySpot: [number, number, number] = [0, 0, 0];
  private detailSpot: [number, number, number] = [0, 0, 0];
  private lastLoading: { title: string; text: string; f: number | null; cancel?: () => void } | null = null;
  private genWarnings: string[] = [];
  private lastRescueToast = -1e9;
  private lastRescueAt = -1e9;
  private lockHintShown = false;
  private readonly wishV = { x: 0, z: 0 };
  private readonly scale = scaleFromCityVoxel(1);
  private readonly offs: Array<() => void> = [];
  private promptKey = '';
  readonly info = { enterCycles: 0 };

  static async start(root: HTMLElement): Promise<WalkGame> {
    const g = new WalkGame();
    await g.init(root);
    return g;
  }

  // ───────────────────────────── startup ─────────────────────────────

  private async init(root: HTMLElement): Promise<void> {
    this.ui = new WalkUi(root, { onResume: () => this.resume(), onExit: () => void this.exit() });
    this.controls = new Controls(this.ui.view);
    this.controls.onLockFailed = () => {
      if (this.lockHintShown) return;
      this.lockHintShown = true;
      this.ui.toast('Mouse capture is unavailable here: click and drag to look.', 'ok', 6000);
    };
    this.controls.onPauseRequest = () => {
      if (this.state === 'playing') this.pauseGame();
      else if (this.state === 'paused') this.resume();
    };
    this.on(window, 'keydown', (e: KeyboardEvent) => {
      if (e.code === 'Escape' && this.state === 'generating') this.cancelGeneration();
      else if (e.code === 'F3' && !e.repeat) this.showStats = !this.showStats;
    });
    this.on(window, 'error', (e: ErrorEvent) => this.reportError(e.error ?? e.message));
    this.on(window, 'unhandledrejection', (e: PromiseRejectionEvent) => this.reportError(e.reason));
    this.on(window, 'pagehide', () => this.dispose());
    this.on(window, 'contextmenu', (e: Event) => e.preventDefault());
    const offWarn = window.voxel.onWarning((e) => this.onWarning(e.code, e.message));
    this.offs.push(offWarn);

    this.session = await window.voxel.walkSession();
    const w = this.session.world;
    this.details = [...w.details];
    this.refreshSaved();

    const progress = (text: string, f: number | null): void => this.load('Loading world', `${w.name}\n${text}`, f);
    const { store, voxels, bytes } = await loadStore(this.session.vwgPath, progress);
    this.voxels = voxels;
    if (store.voxels === 0) throw new Error('This world has no voxels.');
    void bytes;
    this.scaleSet(store.vs);

    this.load('Loading world', 'Preparing terrain', null);
    const table = buildGroupTable(store);
    const budget = planWalkBudget(voxels, table.span, this.degrade);
    this.glh = await GlHost.create(this.ui.view, budget.render);
    this.glh.onResize = (cw, ch) => { this.camera.aspect = cw / ch; this.camera.updateProjectionMatrix(); };
    this.glh.resize();
    this.glh.onGpuReset = () => { this.city?.streamer.resetGpu(); this.detail?.streamer.resetGpu(); };
    this.glh.onGone = () => void this.remount();

    this.city = this.makeWorld(store, table, budget, false);
    this.cur = this.city;
    this.refreshSaved(); // now that the city exists the door cells are snapped to the real ground
    this.applyKit(false);
    this.mover = new Mover(store, this.scale);
    this.mover.speeds = CITY_SPEEDS;
    this.cityProbe = new Mover(store, this.scale);
    this.refreshSaved();

    if (this.session.buildingIndexPath) {
      try {
        const idx = await window.voxel.readBuildingIndex(this.session.buildingIndexPath);
        this.buildings = idx.buildings;
        this.byId = new Map(idx.buildings.map((bb) => [bb.id, bb]));
        this.grid = new BuildingGrid(this.buildings, store.vs);
      } catch (e) {
        this.ui.toast(`Building index unavailable (${errorText(e)}); buildings cannot be entered.`, 'warn', 6000);
      }
    }

    // spawn
    const want = this.session.spawn ?? {
      x: ((store.min[0] + store.max[0]) / 2) * 1, z: ((store.min[2] + store.max[2]) / 2) * 1,
    };
    const sp = findSpawn(store, want.x, want.z, boxFits(this.mover));
    this.mover.teleport(sp.x, sp.y, sp.z);
    this.citySpot = [sp.x, sp.y, sp.z];
    this.mover.lastSafe.set(this.citySpot);
    if (sp.how === 'fallback') this.ui.toast('No free ground found at the start point; starting on the highest voxel.', 'warn', 6000);
    else if (sp.movedM > 3) this.ui.toast(`Start point was inside a building or on a roof; moved ${Math.round(sp.movedM)} m to open ground.`, 'ok', 5000);
    this.controls.yaw = 0;

    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    this.exposeDebug();

    await this.waitReady(Math.min(this.city.streamer.radius, Math.max(45, table.span * 0.6)), 20_000, (have, need) =>
      this.load('Building terrain', `${have} / ${need} blocks around you`, need ? have / need : null));
    this.hideLoad();
    this.state = 'paused';
    this.pauseGame(true);
  }

  /** Loading card; remembered so it can be restored after a graphics reset. */
  private load(title: string, text: string, f: number | null, cancel?: () => void): void {
    this.lastLoading = { title, text, f, cancel };
    this.ui.showLoading(title, text, f, cancel);
  }

  private scaleSet(cityVs: number): void {
    Object.assign(this.scale, scaleFromCityVoxel(cityVs));
  }

  private on<K extends keyof WindowEventMap>(t: Window, k: K, f: (e: WindowEventMap[K]) => void): void {
    t.addEventListener(k, f as EventListener);
    this.offs.push(() => t.removeEventListener(k, f as EventListener));
  }

  private makeKit(indoor: boolean): Kit {
    const scene = new THREE.Scene();
    const fog = new THREE.Fog(indoor ? HAZE : SKY, 100, 1000);
    scene.fog = fog;
    const hemi = indoor ? new THREE.HemisphereLight(0xffffff, 0xb4aa9a, 1.6) : new THREE.HemisphereLight(0xdfeeff, 0x6b6558, 1.1);
    const sun = new THREE.DirectionalLight(0xffffff, indoor ? 1.3 : 2.0);
    sun.position.set(0.5, 1, 0.8);
    scene.add(hemi, sun);
    let fill: THREE.DirectionalLight | null = null;
    if (indoor) {
      fill = new THREE.DirectionalLight(0xfff2e0, 0.9);
      scene.add(fill, fill.target);
    }
    return { scene, sun, fill, fog };
  }

  private makeWorld(store: ChunkStore, table: GroupTable, budget: WalkBudget, indoor: boolean): WorldCtx {
    const kit = this.makeKit(indoor);
    const limits = { rMin: budget.rMin, rMax: budget.rMax, maxTriangles: budget.maxTriangles, maxBytes: budget.maxGeometryBytes };
    const streamer = new GroupStreamer({
      store, table, material: this.material, ao: budget.ao, limits,
      radius: indoor ? budget.rMax : Math.min(budget.rMax, Math.max(budget.rMin, 260)),
    });
    kit.scene.add(streamer.group);
    return { store, table, streamer, kit, budget, limits };
  }

  private applyKit(indoor: boolean): void {
    this.ui.view.style.background = indoor
      ? '#' + HAZE.toString(16).padStart(6, '0')
      : `linear-gradient(to bottom, ${SKY_TOP} 0%, #${SKY.toString(16)} 55%, #${SKY.toString(16)} 100%)`;
  }

  // ───────────────────────────── state ─────────────────────────────

  private setState(s: State): void {
    this.state = s;
    this.controls.setEnabled(s === 'playing');
    this.ui.setCrosshair(s === 'playing');
    if (s !== 'playing') { this.promptKey = ''; this.ui.setPrompt(null); }
  }

  private pauseGame(first = false): void {
    this.setState('paused');
    this.controls.releaseLock();
    this.ui.showPause(true, first);
    this.firstRun = false;
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.ui.showPause(false);
    this.setState('playing');
    this.controls.requestLock();
  }

  private async exit(): Promise<void> {
    try { await window.voxel.endWalk(); } catch (e) { this.ui.toast(`Could not close the walking view: ${errorText(e)}`, 'err'); }
  }

  private reportError(e: unknown): void {
    const msg = errorText(e);
    console.error('[walk]', e);
    if (this.state === 'loading' || !this.glh) this.fatalError(msg);
    else this.ui.toast(msg, 'err', 6000);
  }

  fatalError(msg: string): void {
    this.setState('fatal');
    this.controls?.releaseLock();
    this.ui.showFatal(msg);
  }

  // ───────────────────────────── frame loop ─────────────────────────────

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dtRaw = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(Math.max(dtRaw, 0), 0.1);
    this.frameMs = this.frameMs * 0.8 + dtRaw * 1000 * 0.2;
    this.fpsAcc += dtRaw;
    this.fpsFrames++;
    if (this.glh.lost || this.state === 'fatal') return;
    try {
      this.tick(dt, now);
    } catch (e) {
      this.reportError(e);
    }
  };

  private tick(dt: number, now: number): void {
    const c = this.controls, m = this.mover, w = this.cur;
    if (this.state === 'playing') {
      c.wish(this.wishV);
      m.speedScale = c.speedMul;
      m.step(dt, { wishX: this.wishV.x, wishZ: this.wishV.z, run: c.run, jump: c.consumeJump() });
      if (m.rescued) this.onRescued(now, 'Back on solid ground');
      else if (this.outOfBounds()) { this.rescueToSpot(); this.onRescued(now, 'Back inside the map'); }
      this.updateTriggers(dt);
    }

    // camera
    const ey = m.p[1]! + EYE_HEIGHT;
    if (!this.haveEye || Math.abs(ey - this.eyeY) > 2.5) { this.eyeY = ey; this.haveEye = true; }
    else this.eyeY += (ey - this.eyeY) * (1 - Math.exp(-dt * 22));
    const cam = this.camera;
    cam.position.set(m.p[0]!, this.eyeY, m.p[2]!);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(c.pitch, c.yaw, 0);
    const fwdX = -Math.sin(c.yaw), fwdZ = -Math.cos(c.yaw);

    // streaming
    const busy = this.state === 'loading' || this.state === 'transition';
    const slice = busy ? 14 : this.frameMs > 22 ? 1.5 : this.frameMs > 18 ? 2.5 : w.budget.sliceMs;
    w.streamer.update(m.p[0]!, m.p[1]!, m.p[2]!, fwdX, fwdZ, slice, now);
    const fog = w.streamer.fog();
    w.kit.fog.near = fog.near;
    w.kit.fog.far = fog.far;
    const far = Math.max(60, w.streamer.radius * 1.2 + w.streamer.hysteresis);
    if (Math.abs(cam.far - far) > far * 0.05) { cam.far = far; cam.updateProjectionMatrix(); }
    if (w.kit.fill) {
      w.kit.fill.position.copy(cam.position);
      w.kit.fill.target.position.set(cam.position.x + fwdX, cam.position.y - 0.3, cam.position.z + fwdZ);
    }

    this.glh.renderer.render(w.kit.scene, cam);

    this.hudT += dt;
    if (this.hudT >= 0.25) {
      this.hudT = 0;
      this.fps = this.fpsFrames / Math.max(this.fpsAcc, 1e-3);
      this.fpsAcc = 0;
      this.fpsFrames = 0;
      this.updateHud();
    }
  }

  private updateHud(): void {
    const m = this.mover, vs = this.cur.store.vs;
    const p = m.p;
    let s = `${this.fps.toFixed(0)} FPS\nx ${p[0]!.toFixed(1)}  z ${p[2]!.toFixed(1)}  y ${p[1]!.toFixed(1)} m`;
    if (this.mode === 'detail' && this.detail) {
      const st = storeyAt(this.detail.floorYs, vs, p[1]!);
      s += `\n${this.detail.name}${st >= 0 ? `  -  floor ${st + 1} of ${this.detail.floorYs.length}` : ''}`;
    } else s += `\nOutside  -  ${this.controls.speedMul !== 1 ? `speed x${this.controls.speedMul.toFixed(2)}` : 'walking'}${m.inWater ? '  -  wading' : ''}`;
    if (this.showStats) {
      const st = this.cur.streamer.stats;
      const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
      s += `\nradius ${st.radius.toFixed(0)} m  blocks ${st.resident}/${st.groups}  queue ${st.queued}` +
        `\ntris ${(st.triangles / 1e6).toFixed(2)} M  geo ${(st.geometryBytes / 1048576).toFixed(0)} MB  calls ${this.glh.renderer.info.render.calls}` +
        `\nheap ${(heap / 1048576).toFixed(0)} MB  max slice ${st.maxSliceMs.toFixed(1)} ms`;
    }
    this.ui.setHud(s);
  }

  // ───────────────────────────── entrances ─────────────────────────────

  private refreshSaved(): void {
    const r = collectSavedEntrances(this.details);
    const out: SavedEntrance[] = [];
    for (const se of r.entrances) {
      const e = this.snapCity(se.entrance);
      if (e) out.push({ ...se, entrance: e });
    }
    this.saved = out;
    const usable = new Set(out.map((o) => o.buildingId));
    const no = new Map<string, string>();
    for (const id of r.noEntrance) no.set(id, 'No entrance (regenerate interior)');
    for (const se of r.entrances) if (!usable.has(se.buildingId)) no.set(se.buildingId, 'No entrance inside the map');
    this.noEntrance = no;
  }

  /**
   * Door cell on the real city ground (see snapDoorCell), or null when the door lies outside the map or has no
   * standable ground near it: such a door is not usable (entering through it would drop the player off the map).
   */
  private snapCity(e: WalkEntrance): WalkEntrance | null {
    const st = this.city?.store;
    if (!st || !this.cityProbe) return e;
    if (!entranceInBounds(e, st.min, st.max)) return null;
    const cell = snapDoorCell(st, e.city, boxFits(this.cityProbe));
    return cell ? { ...e, city: cell } : null;
  }

  private usableEntrances(list: readonly WalkEntrance[] | undefined): WalkEntrance[] {
    const out: WalkEntrance[] = [];
    for (const e of list ?? []) { const s = this.snapCity(e); if (s) out.push(s); }
    return out;
  }

  private isEligible(b: BuildingInfo): boolean {
    let v = this.eligible.get(b.id);
    if (v === undefined) {
      v = interiorEligibility(b, this.city.store.vs).ok;
      this.eligible.set(b.id, v);
    }
    return v;
  }

  private updateTriggers(dt: number): void {
    const inter = this.controls.consumeInteract();
    const m = this.mover;
    const x = m.p[0]!, y = m.p[1]!, z = m.p[2]!;
    if (this.cooldown > 0) { this.cooldown -= dt; this.setPrompt(null); return; }

    if (this.mode === 'detail') {
      const d = this.detail;
      if (d) for (const e of d.entrances) if (crossedDoor(e, x, y, z)) { void this.leaveDetail(e); return; }
      this.setPrompt(null);
      return;
    }
    const vs = this.city.store.vs;

    // 1. doors of saved interiors: walking into the door zone enters, E works from a bit further away
    if (this.saved.length > 0) {
      const hit = findEntrance(this.saved, vs, x, y, z, m.vx, m.vz, triggerConfig(vs));
      if (hit) {
        const se = this.saved[hit.index]!;
        const b = this.byId.get(se.buildingId);
        const label = se.buildingName ?? (b ? buildingLabel(b) : 'the building');
        this.setPrompt(`to enter ${label}`, 'E');
        if (hit.auto || inter) void this.enterDetail({ kind: 'saved', detailId: se.detailId }, se.entrance, label);
        return;
      }
    }

    // 2. buildings without a saved interior: explicit E only, next to an outward wall (never by accident)
    if (this.grid) {
      const cand = findDoorCandidate(this.grid, (b) => this.isEligible(b), vs, x, y, z, 1.5);
      if (cand) {
        const b = cand.building;
        if (this.saved.some((s) => s.buildingId === b.id)) { this.setPrompt(null); return; }
        const no = this.noEntrance.get(b.id);
        if (no) { this.setPrompt(no, undefined, true); return; }
        const why = this.failed.get(b.id);
        if (why) this.setPrompt(why.text.includes('Press E') ? why.text : `${why.text} Press E to retry.`, undefined, true, why.tech);
        else this.setPrompt(`to generate the interior of ${buildingLabel(b)}`, 'E');
        if (inter) void this.generateInterior(b, [x / vs, z / vs]);
        return;
      }
    }
    this.setPrompt(null);
  }

  private setPrompt(text: string | null, key?: string, warn = false, title = ''): void {
    const k = text ? `${key ?? ''}|${text}|${warn}` : '';
    if (k === this.promptKey) return;
    this.promptKey = k;
    this.ui.setPrompt(text, key, warn, title);
  }

  private cancelGeneration(): void {
    this.ui.setLoadingCancelling();
    void window.voxel.cancel().catch(() => undefined);
  }

  /** Python warnings that explain a missing entrance etc.; collected during generation, toasted otherwise. */
  private onWarning(code: string, message: string): void {
    if (!/^(ENTRANCE_|INTERIOR_|DETAIL_NOT_SAVED)/.test(code)) return;
    const short = message.length > 150 ? `${message.slice(0, 147)}...` : message;
    console.warn(`[walk] ${code}: ${message}`);
    if (this.state === 'generating') this.genWarnings.push(short);
    else this.ui.toast(short, 'warn', 6000);
  }

  private async generateInterior(b: BuildingInfo, stand: [number, number]): Promise<void> {
    if (this.state !== 'playing') return;
    const w = this.session.world;
    const vs = this.city.store.vs;
    const est = estimateDetailVoxels(b, vs, INTERIOR_VOXEL, { enabled: true });
    const maxVoxels = Math.round(Math.min(30e6, Math.max(3e6, est * 1.8 + 1.5e6)));
    this.setState('generating');
    this.controls.releaseLock();
    this.genWarnings = [];
    const title = buildingLabel(b);
    const card = (text: string, f: number | null): void =>
      this.load('Generating interior', `${title}\n${text}\nPress Esc or Cancel to stop.`, f, () => this.cancelGeneration());
    card('This takes a few seconds', null);
    const unsub = window.voxel.onProgress((e) => card(e.message || e.stage, e.pct >= 0 ? e.pct / 100 : null));
    try {
      const res = await window.voxel.detail({
        ref: {
          bbox: w.bbox, buildingId: b.id, metersPerFloor: w.params.metersPerFloor, defaultBuildingHeight: w.params.defaultBuildingHeight,
          ...(w.params.dataSource ? { dataSource: w.params.dataSource } : {}),
        },
        worldId: w.id,
        voxelSize: INTERIOR_VOXEL,
        interior: { enabled: true },
        maxVoxels,
      });
      unsub();
      this.failed.delete(b.id);
      if (res.record) { this.details = [res.record, ...this.details.filter((d) => d.id !== res.record!.id)]; this.refreshSaved(); }
      this.hideLoad();
      const note = this.genWarnings.length ? ` ${this.genWarnings[this.genWarnings.length - 1]}` : '';
      const all = res.stats.entrances ?? [];
      const usable = this.usableEntrances(all);
      if (usable.length === 0) {
        const msg = all.length === 0 ? 'No entrance (regenerate interior)' : 'No entrance inside the map';
        this.noEntrance.set(b.id, msg);
        this.ui.toast(`${msg}.${note}`, 'warn', 7000);
        this.setState('playing');
        this.controls.requestLock();
        return;
      }
      const ent = nearestEntrance(usable, stand[0], stand[1])!;
      await this.enterDetail({ kind: 'fresh', vwgPath: res.vwgPath, stats: res.stats }, ent, title);
    } catch (e) {
      unsub();
      this.hideLoad();
      const why = explainInteriorError(e, maxVoxels);
      if (why === null) this.ui.toast('Interior generation cancelled', 'warn', 2500);
      else {
        console.error('[walk] interior failed:', why.tech);
        this.failed.set(b.id, why);
        this.ui.toast(why.text, 'err', 7000);
      }
      if ((this.state as State) === 'generating') { this.setState('playing'); this.controls.requestLock(); }
    }
  }

  // ───────────────────────────── city <-> detail ─────────────────────────────

  private async waitReady(radius: number, timeoutMs: number, onProgress?: (have: number, need: number) => void): Promise<void> {
    const t0 = performance.now();
    for (;;) {
      const p = this.mover.p;
      const r = this.cur.streamer.ready(p[0]!, p[1]!, p[2]!, radius);
      onProgress?.(r.have, r.needed);
      if (r.have >= r.needed || performance.now() - t0 > timeoutMs || this.disposed) return;
      await nextFrame();
    }
  }

  private hideLoad(): void {
    this.lastLoading = null;
    this.ui.hideLoading();
  }

  /** Puts the player somewhere known to be standable and forgets the fall history. */
  private placeAt(x: number, y: number, z: number): void {
    const m = this.mover;
    m.teleport(x, y, z);
    m.lastSafe.set(m.p);
    this.haveEye = false;
  }

  private rescueToSpot(): void {
    const s = this.mode === 'detail' ? this.detailSpot : this.citySpot;
    this.placeAt(s[0], s[1], s[2]);
  }

  /** Back to the city after a failed transition (best effort: the pose we left from). */
  private recoverToCity(): void {
    const d = this.detail;
    this.detail = null;
    if (d) { d.streamer.dispose(); d.store.dropCaches(); d.kit.scene.clear(); }
    this.mode = 'city';
    this.cur = this.city;
    this.applyKit(false);
    const m = this.mover;
    m.setWorld(this.city.store, false);
    m.speeds = CITY_SPEEDS;
    const r = this.cityReturn;
    this.placeAt(r[0], r[1], r[2]);
    this.city.streamer.invalidate();
  }

  private async enterDetail(
    src: { kind: 'saved'; detailId: string } | { kind: 'fresh'; vwgPath: string; stats: DetailStats },
    ent: WalkEntrance, name: string,
  ): Promise<void> {
    if (this.state !== 'playing' && this.state !== 'generating') return;
    this.setState('transition');
    this.controls.releaseLock();
    const m = this.mover, c = this.controls;
    try {
      await this.ui.fade(true);
      this.cityReturn = [m.p[0]!, m.p[1]!, m.p[2]!];
      let ctx: DetailCtx;
      try {
        const opened = src.kind === 'saved'
          ? await window.voxel.openDetail(this.session.world.id, src.detailId)
          : { vwgPath: src.vwgPath, stats: src.stats };
        this.load('Entering building', name, null);
        const { store } = await loadStore(opened.vwgPath, (t, f) => this.load('Entering building', `${name}\n${t}`, f));
        const table = buildGroupTable(store);
        const budget = planDetailBudget(planWalkBudget(this.voxels, this.city.table.span, this.degrade));
        const world = this.makeWorld(store, table, budget, true);
        const doors = this.usableEntrances(opened.stats.entrances);
        ctx = { ...world, entrances: doors.length ? doors : [ent], floorYs: opened.stats.floorYs ?? [], stats: opened.stats, buildingId: '', name };
      } catch (e) {
        this.ui.toast(`Could not open the interior: ${errorText(e)}`, 'err', 7000);
        this.cooldown = 1.5;
        return;
      }
      // swap: free the city's GPU geometry (its store stays so we can return instantly)
      this.city.streamer.resetGpu();
      this.detail = ctx;
      this.cur = ctx;
      this.mode = 'detail';
      this.applyKit(true);
      m.setWorld(ctx.store, true);
      m.speeds = INDOOR_SPEEDS;
      this.detailSpot = [ent.inside[0], ent.inside[1] + 0.002, ent.inside[2]];
      this.placeAt(this.detailSpot[0], this.detailSpot[1], this.detailSpot[2]);
      c.yaw = Math.atan2(-ent.dir[0], -ent.dir[1]);
      c.pitch = 0;
      await this.waitReady(Math.min(ctx.streamer.radius, 28), 15_000);
      this.cooldown = 1.2;
      this.info.enterCycles++;
    } catch (e) {
      console.error('[walk] enter failed', e);
      this.ui.toast(`Could not enter the building: ${errorText(e)}`, 'err', 7000);
      this.recoverToCity();
      this.cooldown = 1.5;
    } finally {
      this.hideLoad();
      await this.ui.fade(false);
      if ((this.state as State) === 'transition') {
        this.setState('playing');
        this.controls.requestLock();
      }
    }
  }

  private async leaveDetail(through: WalkEntrance): Promise<void> {
    if (this.state !== 'playing' || !this.detail) return;
    this.setState('transition');
    this.controls.releaseLock();
    try {
      await this.ui.fade(true);
      const d = this.detail;
      if (!d) return;
      // the door's city cell was validated when the detail was opened; fall back to the nearest valid door, else the spawn
      const vs = this.city.store.vs;
      const snapped = this.snapCity(through) ?? this.usableEntrances(d.entrances)[0] ?? null;
      this.detail = null;
      d.streamer.dispose();
      d.store.dropCaches();
      d.kit.scene.clear();
      this.mode = 'city';
      this.cur = this.city;
      this.applyKit(false);
      const m = this.mover, c = this.controls;
      m.setWorld(this.city.store, false);
      m.speeds = CITY_SPEEDS;
      if (snapped) {
        const [cx, cy, cz] = entranceCityMetres(snapped, vs);
        this.placeAt(cx, cy + 0.002, cz);
        c.yaw = Math.atan2(-snapped.cityDir[0], -snapped.cityDir[1]);
      } else {
        this.ui.toast('That door has no ground outside; returning to the start point.', 'warn', 5000);
        this.rescueToSpot();
      }
      c.pitch = 0;
      this.city.streamer.invalidate();
      await this.waitReady(Math.min(this.city.streamer.radius, Math.max(45, this.city.table.span * 0.6)), 15_000);
      this.cooldown = 2;
    } catch (e) {
      console.error('[walk] leave failed', e);
      this.ui.toast(`Could not leave the building cleanly: ${errorText(e)}`, 'err', 7000);
      this.recoverToCity();
      this.cooldown = 1.5;
    } finally {
      await this.ui.fade(false);
      if ((this.state as State) === 'transition') {
        this.setState('playing');
        this.controls.requestLock();
      }
    }
  }

  // ───────────────────────────── robustness ─────────────────────────────

  /** The player left the playable area or fell out of the world: put them back, at most one toast per 5 s. */
  private onRescued(now: number, why: string): void {
    // a second rescue within 3 s means the last standing spot is bad too: use the known-good spot
    if (now - this.lastRescueAt < 3000) this.rescueToSpot();
    this.lastRescueAt = now;
    if (now - this.lastRescueToast > 5000) { this.lastRescueToast = now; this.ui.toast(why, 'warn', 2500); }
  }

  private outOfBounds(): boolean {
    const m = this.mover, st = this.cur.store, vs = st.vs;
    const x = m.p[0]! / vs, z = m.p[2]! / vs;
    return !(Number.isFinite(x + z + m.p[1]!) && x >= st.min[0] && x < st.max[0] && z >= st.min[2] && z < st.max[2]);
  }

  /** The GL context did not come back: rebuild the renderer at a cheaper budget and re-stream. */
  private async remount(): Promise<void> {
    if (this.disposed) return;
    this.degrade = Math.min(4, this.degrade + 1);
    const wasState = this.state;
    const prev = this.ui.loadingVisible ? this.lastLoading : null;
    this.setState('transition');
    this.ui.showLoading('Graphics reset', 'The graphics process was reset; restoring the view at lower quality', null);
    try {
      const b = planWalkBudget(this.voxels, this.city.table.span, this.degrade);
      for (const w of [this.city, this.detail]) {
        if (!w) continue;
        const nb = w === this.city ? b : planDetailBudget(b);
        w.limits.maxTriangles = nb.maxTriangles;
        w.limits.maxBytes = nb.maxGeometryBytes;
        w.limits.rMax = nb.rMax;
      }
      await this.glh.remount(b.render);
      this.glh.resize();
      // give back whatever card was up (generation progress with its Cancel, entering...) and the state we were in
      if (prev) this.ui.showLoading(prev.title, prev.text, prev.f, prev.cancel); else this.ui.hideLoading();
      if (wasState === 'generating' || wasState === 'transition') this.setState(wasState);
      else if (wasState === 'playing') this.pauseGame();
      else this.setState(wasState);
    } catch (e) {
      this.fatalError(`The graphics context could not be recreated: ${errorText(e)}`);
    }
  }

  // ───────────────────────────── debug / teardown ─────────────────────────────

  private exposeDebug(): void {
    if (!import.meta.env.DEV) return;
    const g = this;
    (window as unknown as { __walk: unknown }).__walk = {
      state: () => ({
        state: g.state, mode: g.mode, pos: Array.from(g.mover.p), vel: [g.mover.vx, g.mover.vy, g.mover.vz], onGround: g.mover.onGround,
        yaw: g.controls.yaw, pitch: g.controls.pitch, fps: g.fps, vs: g.cur.store.vs, saved: g.saved.length, buildings: g.buildings.length, noEntrance: Array.from(g.noEntrance),
        stream: { ...g.cur.streamer.stats }, calls: g.glh.renderer.info.render.calls, triangles: g.glh.renderer.info.render.triangles,
        geometries: g.glh.renderer.info.memory.geometries, textures: g.glh.renderer.info.memory.textures,
        heap: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
        canvases: document.querySelectorAll('canvas').length, cycles: g.info.enterCycles,
        min: g.cur.store.min, max: g.cur.store.max, scale: { ...g.scale }, voxels: g.voxels, storeBytes: g.city.store.pos.byteLength + g.city.store.col.byteLength,
      }),
      resume: () => { g.ui.showPause(false); g.setState('playing'); },
      teleport: (x: number, y: number, z: number) => { g.mover.teleport(x, y, z); g.haveEye = false; },
      teleportColumn: (ix: number, iz: number) => {
        const s = g.cur.store, t = s.topSolid(ix, iz);
        if (t === -Infinity) return false;
        g.mover.teleport((ix + 0.5) * s.vs, (t + 1) * s.vs + 0.01, (iz + 0.5) * s.vs); g.haveEye = false; return true;
      },
      look: (yaw: number, pitch = 0) => { g.controls.yaw = yaw; g.controls.pitch = pitch; },
      buildings: () => g.buildings,
      saved: () => g.saved,
      enterSaved: (i = 0) => { const s = g.saved[i]!; return g.enterDetail({ kind: 'saved', detailId: s.detailId }, s.entrance, s.buildingName ?? s.buildingId); },
      enterFake: async (vwgPath: string, stats: DetailStats, ent: WalkEntrance) => g.enterDetail({ kind: 'fresh', vwgPath, stats }, ent, 'test'),
      leave: (i = 0) => g.leaveDetail(g.detail!.entrances[i]!),
      addRecord: (r: DetailRecord) => { g.details = [r, ...g.details]; g.refreshSaved(); },
      generate: (i: number) => g.generateInterior(g.buildings[i]!, [g.mover.p[0]! / g.cur.store.vs, g.mover.p[2]! / g.cur.store.vs]),
      loseContext: () => g.glh.renderer.getContext().getExtension('WEBGL_lose_context')?.loseContext(),
      restoreContext: () => g.glh.renderer.getContext().getExtension('WEBGL_lose_context')?.restoreContext(),
      showStats: (v = true) => { g.showStats = v; },
      cooldown: (s: number) => { g.cooldown = s; },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.offs.forEach((f) => f());
    this.offs.length = 0;
    this.controls?.dispose();
    this.detail?.streamer.dispose();
    this.city?.streamer.dispose();
    this.material.dispose();
    this.glh?.dispose();
    this.ui?.dispose();
  }
}
