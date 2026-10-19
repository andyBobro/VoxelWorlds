import * as THREE from 'three';
import { parseVwg, type VwgData } from '../../shared/vwg';
import { CameraRig, type CameraMode, type CameraState } from './camera';
import { Hud } from './hud';
import { Highlight, type HighlightSpec } from './highlight';
import { Markers } from './markers';
import { buildingFocus } from './markerGeometry';
import type { BuildingInfo } from '../../shared/contract';
import { VoxelWorld } from './world';
import { detailGeometryBudget, planBudget, rendererAttempts, type RenderBudget, type RendererOptions } from './budget';

export type { CameraMode } from './camera';
export type { HighlightSpec } from './highlight';

/** Surface hit in voxel-grid units (world metres / voxelSize). */
export interface SurfaceHit { p: [number, number, number]; n: [number, number, number]; }
export interface DetailInfo { voxels: number; triangles: number; }

export interface PreviewHandle {
  load(buf: ArrayBuffer): void;
  dispose(): void;
  setCameraMode(mode: CameraMode): void;
  /** Bake ambient occlusion into vertex colours. Rebuilds the current scene. Returns the effective state. */
  setAmbientOcclusion(on: boolean): boolean;
  /** Effective AO state and whether it can be changed for the current scene (false when source data was released). */
  getAmbientOcclusion(): { on: boolean; available: boolean };
  /**
   * Click pick (orbit: click without drag; fly: click when pointer lock is unavailable, or press F at the
   * crosshair while locked). null hit = clicked empty space. Only fires in the city scene.
   */
  onPick: ((hit: SurfaceHit | null) => void) | null;
  /** Overlay (no re-mesh) for the picked building and edge; null clears. */
  setHighlight(h: HighlightSpec | null): void;
  /** Voxel size of the loaded city world (metres), 0 before load. */
  getVoxelSize(): number;
  /** Swap to a separate scene/world built from a detail .vwg. City world/state stay untouched in memory. */
  showDetail(buf: ArrayBuffer): DetailInfo;
  /** Dispose the detail scene and restore city scene + camera. */
  backToCity(): void;
  inDetail(): boolean;
  /** Cutaway: show everything up to and including floor slab `level` (index into floorYs); null = no clip. Does not remesh. */
  setCutaway(slabY: number | null): void;
  /** Overlay markers (no re-mesh) for buildings with saved details; null/empty clears. Survives only until the next load(). */
  setMarkers(buildings: readonly BuildingInfo[] | null): void;
  setMarkersVisible(v: boolean): void;
  /** Smoothly keeps orbit limits; moves the orbit target to the building and zooms to fit. City scene only. */
  focusBuilding(b: BuildingInfo): void;
  /**
   * Fires once when the WebGL context is lost and has not come back within a grace period (or never will).
   * The owner should remount (dispose + mount + load); the canvas is dead until then.
   */
  onContextLost: (() => void) | null;
  /** True when the city scene stopped meshing at the GPU memory budget (outer chunks not shown). */
  isTruncated(): boolean;
  /** Stops (true) / restarts (false) the render loop, e.g. while another window owns the GPU. State and scene are kept. */
  setPaused(paused: boolean): void;
  /** City voxel [x, z] under the view (orbit: the orbit target, fly: the camera); null in a detail scene. For "walk here". */
  getViewSpot(): { x: number; z: number } | null;
}

export interface MountOptions {
  /** Voxel count of the scene about to be loaded; sizes shadows/AA/pixel-ratio/GPU geometry budget. */
  voxels?: number;
  /** Extra tiers of degradation (after a context loss or failed creation); 0 = none. */
  degrade?: number;
}

/** AO adds ~1.3-2x triangles; above this many voxels it defaults to off (re-enable with setAmbientOcclusion). */
export const AO_AUTO_MAX_VOXELS = 2_500_000;
/** Source data is kept (zero-copy views) for AO re-meshing only up to this many voxels. */
const KEEP_DATA_MAX_VOXELS = 12_000_000;

const SKY = 0xbcd6ec; // horizon / fog colour
const SKY_TOP = '#5f95cf';
const SLICE_MS = 3;
const SLICE_MIN_MS = 1;
const FRAME_TARGET_MS = 16.7;

const NOT_BUILDING = new Set(['ground', 'road', 'water', 'vegetation']);

/** World-space (metres) box of voxels whose palette material is not terrain/vegetation; null when the header has no tags or nothing matches. */
export function buildingBounds(data: VwgData): THREE.Box3 | null {
  const mats = data.header.materials;
  if (!mats) return null;
  const isB = new Uint8Array(mats.length);
  let any = false;
  for (let i = 0; i < mats.length; i++) if (!NOT_BUILDING.has(mats[i]!)) { isB[i] = 1; any = true; }
  if (!any) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const { x, y, z, c } = data;
  for (let i = 0; i < c.length; i++) {
    if (!isB[c[i]!]) continue;
    const a = x[i]!, b = y[i]!, d = z[i]!;
    if (a < x0) x0 = a; if (a > x1) x1 = a;
    if (b < y0) y0 = b; if (b > y1) y1 = b;
    if (d < z0) z0 = d; if (d > z1) z1 = d;
  }
  if (x0 === Infinity) return null;
  const vs = data.header.voxelSize;
  return new THREE.Box3(new THREE.Vector3(x0 * vs, y0 * vs, z0 * vs), new THREE.Vector3((x1 + 1) * vs, (y1 + 1) * vs, (z1 + 1) * vs));
}

let quietUntil = 0;
let warnPatched = false;
/** three logs a 'Context Lost' warning for every deliberate forceContextLoss(); swallow only that one, only briefly. */
function quietContextLoss(): void {
  quietUntil = Date.now() + 500;
  if (warnPatched) return;
  warnPatched = true;
  const orig = console.warn.bind(console);
  console.warn = (...a: unknown[]): void => {
    if (Date.now() < quietUntil && typeof a[0] === 'string' && /Context Lost/i.test(a[0])) return;
    orig(...a);
  };
}

function tryCreateRenderer(o: RendererOptions): THREE.WebGLRenderer {
  const r = new THREE.WebGLRenderer({ antialias: o.antialias, alpha: o.alpha, powerPreference: o.powerPreference, stencil: o.stencil });
  r.setPixelRatio(o.pixelRatio);
  return r;
}

const nextFrame = (ms: number): Promise<void> =>
  new Promise((res) => { setTimeout(() => requestAnimationFrame(() => res()), ms); });

/**
 * Creates a renderer, retrying with progressively cheaper options (see rendererAttempts) and waiting between
 * attempts so a stressed GPU process can release the previous context's memory. Throws the last error.
 */
async function createRendererRetry(budget: RenderBudget): Promise<{ renderer: THREE.WebGLRenderer; opts: RendererOptions }> {
  const attempts = rendererAttempts(budget, window.devicePixelRatio || 1);
  let last: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      return { renderer: tryCreateRenderer(attempts[i]!), opts: attempts[i]! };
    } catch (e) {
      last = e;
      console.warn(`WebGL context creation failed (attempt ${i + 1}/${attempts.length}): ${String((e as Error)?.message ?? e)}`);
      await nextFrame(150 * (i + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Async mount with a creation retry ladder; prefer this over mountPreview. */
export async function mountPreviewAsync(container: HTMLElement, opts: MountOptions = {}): Promise<PreviewHandle> {
  const budget = planBudget(opts.voxels ?? 0, opts.degrade ?? 0);
  const { renderer, opts: ro } = await createRendererRetry(budget);
  return mountWith(container, renderer, ro, budget);
}

/** Synchronous mount: walks the whole ladder back to back (no waiting between attempts; use mountPreviewAsync to wait). */
export function mountPreview(container: HTMLElement, opts: MountOptions = {}): PreviewHandle {
  const budget = planBudget(opts.voxels ?? 0, opts.degrade ?? 0);
  const attempts = rendererAttempts(budget, window.devicePixelRatio || 1);
  let last: unknown = null;
  for (const a of attempts) {
    try { return mountWith(container, tryCreateRenderer(a), a, budget); } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function mountWith(container: HTMLElement, renderer: THREE.WebGLRenderer, ropts: RendererOptions, budget: RenderBudget): PreviewHandle {
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.style.overflow = 'hidden';

  // The sky is a CSS gradient behind a transparent canvas (not a scene.background texture): it cannot go black when GL
  // state/textures are lost or replaced (seen after a detail round trip), and costs no texture upload.
  renderer.setClearColor(0x000000, 0);
  const skyHex = '#' + SKY.toString(16).padStart(6, '0');
  container.style.background = `linear-gradient(to bottom, ${SKY_TOP} 0%, ${skyHex} 55%, ${skyHex} 100%)`;
  renderer.localClippingEnabled = true; // detail-scene floor cutaway (material.clippingPlanes)
  renderer.shadowMap.enabled = ropts.shadows || ropts.detailShadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false; // static scene: re-render the shadow map only while chunks are still arriving
  const canvas = renderer.domElement;
  canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;';
  canvas.tabIndex = 0;
  container.appendChild(canvas);

  const makeScene = (shadowSizeWanted: number, cast: boolean): { scene: THREE.Scene; sun: THREE.DirectionalLight } => {
    const shadowSize = Math.min(shadowSizeWanted, ropts.shadowMapSize);
    const sc = new THREE.Scene();
    sc.fog = new THREE.Fog(SKY, 100, 1000);
    const hemi = new THREE.HemisphereLight(0xdfeeff, 0x6b6558, 1.1);
    const sn = new THREE.DirectionalLight(0xffffff, 2.0);
    sn.position.set(0.5, 1, 0.8);
    sn.castShadow = cast;
    sn.shadow.mapSize.set(shadowSize, shadowSize);
    sn.shadow.radius = 3;
    sc.add(hemi, sn, sn.target);
    return { scene: sc, sun: sn };
  };
  const { scene: cityScene, sun: citySun } = makeScene(4096, ropts.shadows); // size clamped to the budget's shadow map size
  let scene = cityScene; // the scene being rendered
  const sun = citySun;

  /** Fit sun + shadow frustum + fog + camera planes to a bounding sphere. */
  const fitScene = (sc: THREE.Scene, sn: THREE.DirectionalLight, center: THREE.Vector3, radius: number, vs: number): void => {
    camera.near = Math.max(0.05, radius * 0.0005);
    camera.far = radius * 12;
    camera.updateProjectionMatrix();
    const fog = sc.fog as THREE.Fog;
    fog.near = radius * 2.5;
    fog.far = radius * 9;
    sn.target.position.copy(center);
    sn.position.copy(center).addScaledVector(new THREE.Vector3(0.5, 1, 0.8).normalize(), radius * 2);
    const c = sn.shadow.camera;
    c.left = c.bottom = -radius * 1.05;
    c.right = c.top = radius * 1.05;
    c.near = radius * 0.2;
    c.far = radius * 4;
    c.updateProjectionMatrix();
    sn.shadow.bias = -0.0004;
    sn.shadow.normalBias = vs * 0.6;
    renderer.shadowMap.needsUpdate = true;
  };

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  camera.position.set(60, 60, 80);

  let cityWorld: VoxelWorld | null = null;
  let grid: THREE.GridHelper | null = null;
  let disposed = false;

  const hud = new Hud(container, () => rig.setMode(rig.mode === 'orbit' ? 'fly' : 'orbit'));
  const rig = new CameraRig(camera, canvas, () => hud.setMode(rig.mode, rig.locked, rig.lockFailed));
  hud.setMode(rig.mode, rig.locked, rig.lockFailed);

  const resize = (): void => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // preventDefault lets the browser restore the context (three re-inits GL state and re-uploads geometry). If it
  // does not come back within the grace period the canvas stays blank, so tell the owner to remount instead.
  let onContextLostCb: (() => void) | null = null;
  let lostTimer: ReturnType<typeof setTimeout> | null = null;
  const onLost = (e: Event): void => {
    e.preventDefault();
    if (lostTimer || disposed) return;
    lostTimer = setTimeout(() => {
      lostTimer = null;
      if (!disposed) onContextLostCb?.();
    }, 1500);
  };
  const onRestored = (): void => {
    if (lostTimer) { clearTimeout(lostTimer); lostTimer = null; }
    renderer.shadowMap.needsUpdate = true;
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  let hl: Highlight | null = null;
  let hlSpec: HighlightSpec | null = null;
  const crosshair = document.createElement('div');
  crosshair.style.cssText =
    'position:absolute;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;pointer-events:none;z-index:5;display:none;' +
    'border:2px solid rgba(255,255,255,.85);border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.6);';
  container.appendChild(crosshair);

  // ---- detail scene state
  interface Detail {
    scene: THREE.Scene; sun: THREE.DirectionalLight; material: THREE.MeshLambertMaterial;
    world: VoxelWorld; data: VwgData; plane: THREE.Plane; cam: CameraState;
  }
  let detail: Detail | null = null;
  let onPickCb: ((hit: SurfaceHit | null) => void) | null = null;

  const activeWorld = (): VoxelWorld | null => (detail ? detail.world : cityWorld);
  const syncCrosshair = (): void => {
    crosshair.style.display = rig.mode === 'fly' && rig.locked && !detail && onPickCb ? 'block' : 'none';
  };
  rig.onModeChange = syncCrosshair;

  let markers: Markers | null = null;
  let markersVisible = true;

  const clearWorld = (): void => {
    markers?.dispose();
    if (markers) cityScene.remove(markers.group);
    markers = null;
    if (cityWorld) {
      cityScene.remove(cityWorld.group);
      cityWorld.dispose();
      cityWorld = null;
    }
    hl?.dispose();
    if (hl) cityScene.remove(hl.group);
    hl = null;
    if (grid) {
      cityScene.remove(grid);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      grid = null;
    }
  };

  let kept: VwgData | null = null;
  let aoOn = true;
  let userAo: boolean | null = null; // explicit user choice; survives load()
  const setAmbientOcclusion = (on: boolean): boolean => {
    if (disposed) return aoOn;
    if (detail) {
      userAo = on;
      if (on === aoOn) return aoOn;
      const d = detail;
      d.scene.remove(d.world.group);
      d.world.dispose();
      aoOn = on;
      d.world = new VoxelWorld(d.data, d.material, aoOn, detailGeometryBudget(budget.maxGeometryBytes, cityWorld?.stats.geometryBytes ?? 0));
      d.scene.add(d.world.group);
      renderer.shadowMap.needsUpdate = true;
      return aoOn;
    }
    if (!cityWorld) {
      userAo = aoOn = on;
      return aoOn;
    }
    if (!kept) return aoOn; // source data was released (very large scene): choice unavailable
    userAo = on;
    if (on === aoOn) return aoOn;
    cityScene.remove(cityWorld.group);
    cityWorld.dispose();
    aoOn = on;
    cityWorld = new VoxelWorld(kept, material, aoOn, budget.maxGeometryBytes, budget.maxTriangles);
    cityScene.add(cityWorld.group);
    renderer.shadowMap.needsUpdate = true;
    return aoOn;
  };

  // ---- picking
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const doPick = (clientX: number, clientY: number, centre: boolean): void => {
    if (!cityWorld || detail || !onPickCb) return;
    const r = canvas.getBoundingClientRect();
    if (centre) ndc.set(0, 0);
    else ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(cityWorld.group.children, false);
    const h = hits[0];
    if (!h || !h.face) { onPickCb(null); return; }
    const vs = cityWorld.voxelSize;
    onPickCb({
      p: [h.point.x / vs, h.point.y / vs, h.point.z / vs],
      n: [Math.round(h.face.normal.x), Math.round(h.face.normal.y), Math.round(h.face.normal.z)],
    });
  };
  let down: { x: number; y: number; t: number } | null = null;
  const onDown = (e: PointerEvent): void => {
    down = e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
  };
  const onUp = (e: PointerEvent): void => {
    const d = down;
    down = null;
    if (!d || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 600) return; // drag, not click
    if (rig.mode === 'fly' && (rig.locked || !rig.lockFailed)) return; // click captures the mouse; use F
    doPick(e.clientX, e.clientY, false);
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);

  const onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'o' || e.key === 'O') setAmbientOcclusion(!aoOn);
    else if ((e.key === 'f' || e.key === 'F') && rig.mode === 'fly' && !e.repeat) doPick(0, 0, true);
  };
  canvas.addEventListener('keydown', onKey);

  let lastT = performance.now();
  let fpsAcc = 0;
  let fpsFrames = 0;
  let fps = 0;
  let hudT = 0;

  const frame = (now: number): void => {
    const dt = Math.min((now - lastT) / 1000, 0.25);
    lastT = now;
    // Adaptive slice: shrink when the previous frame ran long so meshing never starves rendering.
    const frameMs = dt * 1000;
    const slice = frameMs > FRAME_TARGET_MS * 1.5 ? SLICE_MIN_MS : frameMs > FRAME_TARGET_MS ? 2 : SLICE_MS;
    const world = activeWorld();
    if (world && !world.done) {
      world.step(slice);
      renderer.shadowMap.needsUpdate = true; // also covers the frame in which the last chunk lands
    }
    rig.update(dt);
    renderer.render(scene, camera);

    fpsAcc += dt;
    fpsFrames++;
    hudT += dt;
    if (hudT >= 0.4) {
      fps = fpsFrames / fpsAcc;
      fpsAcc = 0;
      fpsFrames = 0;
      hudT = 0;
      const s = world?.stats;
      hud.setStats({
        fps,
        voxels: s?.voxels ?? 0,
        triangles: s?.triangles ?? 0,
        calls: renderer.info.render.calls,
        built: s?.chunksBuilt ?? 0,
        total: s?.chunksTotal ?? 0,
        speed: rig.speed,
        mode: rig.mode,
        ao: aoOn,
        aoToggle: detail ? true : kept !== null,
        truncated: s?.truncated ?? false,
        inDetail: detail !== null,
        geoMB: s ? s.geometryBytes / 1048576 : 0,
      });
    }
  };
  renderer.setAnimationLoop(frame);
  let paused = false;

  const applyHighlight = (): void => {
    if (!cityWorld) return;
    if (!hl) {
      hl = new Highlight(cityWorld.voxelSize);
      cityScene.add(hl.group);
    }
    hl.set(hlSpec);
  };

  const teardownDetail = (): void => {
    if (!detail) return;
    const d = detail;
    detail = null;
    d.scene.remove(d.world.group);
    d.world.dispose();
    d.material.dispose();
    d.sun.shadow.map?.dispose();
  };

  return {
    get onContextLost() { return onContextLostCb; },
    set onContextLost(cb) { onContextLostCb = cb; },
    isTruncated: () => cityWorld?.stats.truncated ?? false,
    setPaused(p: boolean): void {
      if (disposed || p === paused) return;
      paused = p;
      if (p) renderer.setAnimationLoop(null);
      else {
        lastT = performance.now(); // no huge dt after the pause
        renderer.setAnimationLoop(frame);
      }
    },
    getViewSpot(): { x: number; z: number } | null {
      if (detail || !cityWorld) return null;
      const vs = cityWorld.voxelSize;
      const p = rig.mode === 'orbit' ? rig.orbit.target : camera.position;
      return Number.isFinite(p.x + p.z) && vs > 0 ? { x: p.x / vs, z: p.z / vs } : null;
    },
    get onPick() { return onPickCb; },
    set onPick(cb) { onPickCb = cb; syncCrosshair(); },

    load(buf: ArrayBuffer): void {
      if (disposed) return;
      const data = parseVwg(buf); // throws a descriptive Error on corrupt input
      teardownDetail();
      scene = cityScene;
      clearWorld();
      hlSpec = null;
      kept = data.x.length <= KEEP_DATA_MAX_VOXELS ? data : null;
      aoOn = userAo ?? data.x.length <= AO_AUTO_MAX_VOXELS;
      const w = new VoxelWorld(data, material, aoOn, budget.maxGeometryBytes, budget.maxTriangles);
      cityWorld = w;
      cityScene.add(w.group);

      const size = w.bounds.getSize(new THREE.Vector3());
      const center = w.bounds.getCenter(new THREE.Vector3());
      const radius = Math.max(size.length() / 2, data.header.voxelSize * 4);
      const horiz = Math.max(size.x, size.z, data.header.voxelSize);

      const step = Math.pow(10, Math.ceil(Math.log10(Math.max(horiz * 1.6, 1) / 60)));
      const gridSize = Math.ceil((horiz * 1.6) / step) * step;
      grid = new THREE.GridHelper(gridSize, Math.round(gridSize / step), 0x445566, 0x8899aa);
      grid.position.set(center.x, Math.min(0, w.bounds.min.y) - data.header.voxelSize * 0.02, center.z);
      cityScene.add(grid);

      fitScene(cityScene, sun, center, radius, data.header.voxelSize);
      rig.frame(center, radius, data.header.voxelSize);
    },

    setCameraMode(mode: CameraMode): void {
      rig.setMode(mode);
    },

    setAmbientOcclusion,
    getAmbientOcclusion: () => ({ on: aoOn, available: detail ? true : kept !== null }),

    setHighlight(h: HighlightSpec | null): void {
      hlSpec = h;
      applyHighlight();
    },
    getVoxelSize: () => cityWorld?.voxelSize ?? 0,

    setMarkers(list: readonly BuildingInfo[] | null): void {
      if (!cityWorld) return;
      if (!list || list.length === 0) {
        markers?.set([]); // keep the overlay (and its texture) for the next non-empty call
        return;
      }
      if (!markers) {
        markers = new Markers(cityWorld.voxelSize);
        cityScene.add(markers.group);
      }
      markers.set(list);
      markers.group.visible = markersVisible;
    },
    setMarkersVisible(v: boolean): void {
      markersVisible = v;
      if (markers) markers.group.visible = v;
    },
    focusBuilding(b: BuildingInfo): void {
      if (!cityWorld || detail) return;
      const f = buildingFocus(b), vs = cityWorld.voxelSize;
      rig.focus(new THREE.Vector3(f.cx * vs, f.cy * vs, f.cz * vs), Math.max(f.radius * vs, vs * 4));
    },

    showDetail(buf: ArrayBuffer): DetailInfo {
      if (disposed || !cityWorld) throw new Error('No city scene loaded');
      const data = parseVwg(buf);
      teardownDetail();
      const cam = rig.saveState();
      const { scene: ds, sun: dsun } = makeScene(2048, ropts.detailShadows);
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e9);
      mat.clippingPlanes = [plane];
      mat.clipShadows = true;
      const world = new VoxelWorld(data, mat, userAo ?? true, detailGeometryBudget(budget.maxGeometryBytes, cityWorld.stats.geometryBytes));
      aoOn = userAo ?? true;
      ds.add(world.group);
      const d: Detail = { scene: ds, sun: dsun, material: mat, world, data, plane, cam };
      detail = d;
      scene = ds;
      const size = world.bounds.getSize(new THREE.Vector3());
      const center = world.bounds.getCenter(new THREE.Vector3());
      const vs = data.header.voxelSize;
      const radius = Math.max(size.length() / 2, vs * 4);
      fitScene(ds, dsun, center, radius, vs);
      // Frame the building itself (non-ground voxels), not the whole ground plate.
      const bb = buildingBounds(data);
      if (bb) {
        const bc = bb.getCenter(new THREE.Vector3());
        const br = Math.max(bb.getSize(new THREE.Vector3()).length() / 2, vs * 4);
        camera.near = Math.max(0.05, br * 0.0005);
        camera.updateProjectionMatrix();
        rig.frame(bc, br, vs);
      } else rig.frame(center, radius, vs);
      syncCrosshair();
      return { voxels: data.x.length, triangles: 0 };
    },

    backToCity(): void {
      if (!detail) return;
      const cam = detail.cam;
      teardownDetail();
      scene = cityScene;
      rig.restoreState(cam);
      aoOn = cityWorld?.stats.ao ?? aoOn;
      renderer.shadowMap.needsUpdate = true;
      syncCrosshair();
    },

    inDetail: () => detail !== null,

    setCutaway(slabY: number | null): void {
      if (!detail) return;
      const vs = detail.data.header.voxelSize;
      // keep voxel rows y <= slabY (the slab itself stays visible so the floor can be seen from above)
      detail.plane.constant = slabY === null ? 1e9 : (slabY + 1.02) * vs; // +2% voxel: a plane exactly on voxel faces z-fights into speckle
      renderer.shadowMap.needsUpdate = true;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      renderer.setAnimationLoop(null);
      ro.disconnect();
      if (lostTimer) { clearTimeout(lostTimer); lostTimer = null; }
      onContextLostCb = null;
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      canvas.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      kept = null;
      teardownDetail();
      rig.dispose();
      hud.dispose();
      crosshair.remove();
      clearWorld();
      citySun.shadow.map?.dispose();
      citySun.shadow.map = null;
      material.dispose();
      container.style.background = '';
      cityScene.clear();
      renderer.renderLists.dispose();
      renderer.dispose();
      quietContextLoss();
      renderer.forceContextLoss(); // release the GL context now; a new renderer is created on every (re)load
      canvas.width = canvas.height = 1; // drop the drawable backing store immediately, not at GC time
      canvas.remove();
    },
  };
}
