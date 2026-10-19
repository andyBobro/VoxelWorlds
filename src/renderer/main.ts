import './dev/installMock'; // browser-only stub, no-op under Electron
import './ui/styles.css';
import type { BuildingInfo, GenerateParams, WorldMeta } from '../shared/contract';
import { extractChanged, friendlyWarning } from './lib/geodata';
import { markedBuildings, markerLegend } from './lib/worlds';
import { MapView } from './map/mapView';
import { Controls } from './ui/controls';
import { DataSourceControl } from './ui/dataSource';
import { DetailPanel } from './ui/detailPanel';
import { $, errorText, stripCode } from './ui/dom';
import { RemountLimiter, friendlyPreviewError } from './preview/budget';
import { ExportPanel } from './ui/exportPanel';
import { LogPanel } from './ui/logPanel';
import { PreviewHost } from './ui/previewHost';
import { ProgressPanel } from './ui/progressPanel';
import { Tabs } from './ui/tabs';
import { toast } from './ui/toast';
import { WorldSession } from './ui/worldSession';
import { WorldsPanel } from './ui/worldsPanel';

const log = new LogPanel();
const progress = new ProgressPanel();
const tabs = new Tabs();
const preview = new PreviewHost($('preview-container'));
const detailPanel = new DetailPanel($('building-panel'), preview, (m, l) => log.add(m, l ?? 'info'));
const session = new WorldSession();
let detailBusy = false;
let opening = false;
/** id of the saved world whose city is on screen (null: none, or its save failed / it was deleted) */
let displayedWorldId: string | null = null;
preview.onPick = (hit) => detailPanel.handlePick(hit);
detailPanel.onBusy = (b) => {
  detailBusy = b;
  if (!b) flushRecovery();
  controls.setExternalBlock(b ? 'A building detail job is running - cancel it first' : opening ? 'Opening a world...' : '');
  refreshBusy();
};
detailPanel.onRecord = (r) => session.upsertDetailRecord(r);
detailPanel.deleteRecord = (r) => session.deleteDetail(r);
const aoCheck = $<HTMLInputElement>('ao-check');
preview.onAoChange = (on, enabled) => {
  aoCheck.checked = on && enabled;
  aoCheck.disabled = !enabled;
};
aoCheck.addEventListener('change', () => {
  preview.setAmbientOcclusion(aoCheck.checked);
  aoCheck.blur();
});
const emptyHint = $('preview-empty');
const failedBox = $('preview-failed');
const failedMsg = $('preview-failed-msg');
const reloadBtn = $<HTMLButtonElement>('preview-reload');
let lastVwgPath: string | null = null;
let lastIndexPath: string | null = null;
let lastParams: Omit<GenerateParams, 'mapillaryToken'> | null = null;
let lastBuildingCount: number | undefined;
/** voxel count of the city on screen (sizes the preview-failure advice) */
let lastVoxelCount: number | undefined;
let lastSourceInfo: WorldMeta['sourceInfo'];
let cityBuildings: BuildingInfo[] = [];
let reloading = false;
let previewDisposed = false;
/** a city is currently on screen (so export of lastVwgPath and the building panel are meaningful) */
let cityShown = false;

let generating = false;
/** the walking window is open: the whole main window is locked (see setWalking) */
let walking = false;
let exportName = 'voxelworld';

/** Busy state changed: worlds actions and "Walk here" follow it. */
function refreshBusy(): void {
  worldsPanel.refreshBusy();
  syncWalkHere();
}

const source = new DataSourceControl($('source-box'), () => session.worlds);
const controls = new Controls({
  onGenerate: () => void generate(),
  onCancel: () => {
    progress.setCancelling();
    log.add('Cancelling...', 'warn');
    void window.voxel.cancel();
  },
}, source);
const map = new MapView($('map'), (b) => controls.setBBox(b));
const worldsPanel = new WorldsPanel($('worlds-root'), session, {
  openWorld: (m) => openWorld(m),
  loadParams: (m) => applyWorldParams(m),
  openDetail: async (rec) => {
    // Same world as the city on screen: select + fly to the building. Another world: a standalone detail scene over the
    // city that is shown ("Back to city" returns to it). With no city on screen, load the record's world first.
    if (!lastVwgPath && rec.worldId !== displayedWorldId) {
      const w = session.worlds.find((x) => x.id === rec.worldId);
      if (w) await openWorld(w);
      if (displayedWorldId !== rec.worldId) return;
    }
    const same = rec.worldId === displayedWorldId;
    tabs.show('preview');
    await new Promise((r) => requestAnimationFrame(r));
    if (!same) log.add(`Opening a detail of another world (${session.worlds.find((x) => x.id === rec.worldId)?.name ?? rec.worldId}) as a standalone scene`);
    await detailPanel.openSaved(rec, same, !same);
  },
  onWorldDeleted: (m) => {
    if (m.id !== displayedWorldId) return;
    displayedWorldId = null;
    detailPanel.closeScene();
    exporter.setEnabled(false);
    // Clear the stale city, building panel, markers and the detail gate that was derived from it.
    cityBuildings = [];
    lastVwgPath = lastIndexPath = null;
    lastParams = null;
    preview.setMarkers(null);
    preview.dispose();
    cityShown = false;
    detailPanel.clear();
    emptyHint.textContent = 'This world was deleted. Generate a new world or open another one from the Worlds tab.';
    emptyHint.hidden = false;
    syncSaved();
    toast('The world on screen was deleted and closed.', 'warn', 5000);
  },
  regionName: (id) => source.geo.byId.get(id)?.name ?? id,
  walk: (m) => startWalk(m.id),
  busyReason: () => (walking ? 'The walking view is open' : generating ? 'A generate is running' : detailBusy ? 'A building detail job is running' : opening ? 'Opening a world...' : ''),
});

// Saved-detail markers + building-panel lists follow the session.
const markerToggle = $('marker-toggle');
const markerCheck = $<HTMLInputElement>('marker-check');
const markerCount = $('marker-count');
const worldsBadge = $('worlds-badge');
function syncSaved(): void {
  detailPanel.setSavedDetails(session.details);
  const marked = markedBuildings(cityBuildings, session.details);
  preview.setMarkers(marked);
  markerToggle.hidden = !lastVwgPath || emptyHint.hidden === false;
  const detailsOnMarked = session.details.filter((d) => marked.some((b) => b.id === d.buildingId)).length;
  markerCount.textContent = markerLegend(detailsOnMarked, marked.length);
  markerCheck.disabled = marked.length === 0;
  worldsBadge.hidden = session.worlds.length === 0;
  worldsBadge.textContent = String(session.worlds.length);
  syncWalkHere();
}
markerCheck.addEventListener('change', () => { preview.setMarkersVisible(markerCheck.checked); markerCheck.blur(); });
session.onChange(syncSaved);
session.onSaved((i) => {
  if (i.detail) log.add(`Detail saved (${i.detail.buildingId})`);
});
session.onDetailDeleted((r) => detailPanel.recordDeleted(r));
detailPanel.sourceBlock = () => {
  const ds = lastParams?.dataSource;
  if (ds?.kind !== 'pbf' || !source.geo.entriesLoaded || source.geo.entries.has(ds.regionId)) return '';
  return `Download ${source.geo.byId.get(ds.regionId)?.name ?? ds.regionId} again to detail buildings of this world`;
};
detailPanel.sourceNote = () => {
  const ds = lastParams?.dataSource;
  if (ds?.kind !== 'pbf') return '';
  return extractChanged(lastSourceInfo, source.geo.entries.get(ds.regionId)) ? 'The local extract was updated since this world was generated; buildings may differ.' : '';
};
source.geo.onChange(() => detailPanel.refreshBlock());
void session.refreshWorlds();
const exporter = new ExportPanel((format) => {
  const t = detailPanel.activeExport() ?? (lastVwgPath ? { vwgPath: lastVwgPath, suffix: '' } : null);
  if (!t) return Promise.resolve(null);
  return window.voxel.exportAs(format, t.suffix ? `${exportName}_${t.suffix}` : exportName, t.vwgPath);
});

tabs.onChange((t) => {
  if (t === 'map') requestAnimationFrame(() => map.refresh());
  if (t === 'worlds') void session.refreshWorlds();
});

// Sidebar bar is for generate only; analyze/detail progress goes to the detail panel's own bar.
window.voxel.onProgress((e) => { if (generating) progress.update(e); });
window.voxel.onWarning((e) => {
  const f = friendlyWarning(e.code, e.message);
  if (f) { log.add(f.text, 'warn'); toast(f.text, 'warn', 7000); } else log.add(`[${e.code}] ${e.message}`, 'warn');
});
window.voxel.onLog((line) => log.add(line, 'info'));

/** (Re)reads the last generated .vwg and mounts it; on failure shows a Reload button instead of a stale/blank view. */
/** 'ok'; 'kept' = failed before the old scene was touched; 'lost' = failed after it was disposed. */
async function loadPreview(): Promise<'ok' | 'kept' | 'lost'> {
  if (!lastVwgPath || reloading) return 'kept';
  reloading = true;
  reloadBtn.disabled = true;
  failedBox.hidden = true;
  try {
    const path = lastVwgPath;
    const buf = await window.voxel.readVwg(path);
    if (lastVwgPath !== path) return 'lost'; // the world was closed/deleted while its file was being read
    previewDisposed = true;
    cityBuildings = [];
    preview.setMarkers(null);
    pendingRecovery = false; // a loss reported by the handle being replaced is moot
    preview.dispose(); // fresh scene/WebGL context on every (re)load
    if (!(await preview.load(buf))) return 'lost'; // disposed meanwhile (world deleted): nothing mounted, nothing to report
    previewDisposed = false;
    cityShown = true;
    detailPanel.clear(); // only once the new preview is up
    emptyHint.hidden = true;
    emptyHint.textContent = 'Generate a world to see the preview.';
    syncSaved();
    void loadBuildingIndex(lastVwgPath);
    return 'ok';
  } catch (e) {
    const msg = errorText(e);
    if (previewDisposed) { cityShown = false; detailPanel.clear(); } // old scene is gone, selection is meaningless
    log.add(`Preview failed: ${msg}`, 'err');
    failedMsg.textContent = `Preview failed: ${friendlyPreviewError(msg, lastParams?.voxelSize, lastVoxelCount)}`;
    failedBox.hidden = false;
    return previewDisposed ? 'lost' : 'kept';
  } finally {
    reloading = false;
    reloadBtn.disabled = false;
    syncWalkHere();
    flushRecovery(); // the new handle may have lost its context while this load was still running
  }
}

/** Building index is optional (absent on old results / mocks): picking is simply disabled without it. */
async function loadBuildingIndex(vwgPath: string): Promise<void> {
  if (!lastIndexPath || !lastParams) return;
  try {
    const idx = await window.voxel.readBuildingIndex(lastIndexPath);
    if (vwgPath !== lastVwgPath) return; // superseded by a newer generate
    detailPanel.setIndex(idx, {
      bbox: lastParams.bbox, metersPerFloor: lastParams.metersPerFloor,
      defaultBuildingHeight: lastParams.defaultBuildingHeight, cityVwgPath: vwgPath,
      buildingCount: lastBuildingCount,
      dataSource: lastParams.dataSource ?? { kind: 'overpass' },
      ...(displayedWorldId ? { worldId: displayedWorldId } : {}),
    });
    cityBuildings = idx.buildings;
    syncSaved();
  } catch (e) {
    log.add(`Building index unavailable: ${errorText(e)}`, 'warn');
  }
}

// A lost WebGL context that never came back leaves a dead canvas: remount (the host lowers the render budget first).
// At most two automatic remounts per minute so a GPU that keeps dying ends at the Reload button, not in a loop.
const remountLimiter = new RemountLimiter(2, 60_000);
let pendingRecovery = false;
const showPreviewFailed = (text: string): void => {
  failedMsg.textContent = `Preview failed: ${text}`;
  failedBox.hidden = false;
};
function recoverPreview(): void {
  if (!remountLimiter.tryAcquire()) {
    showPreviewFailed(friendlyPreviewError('WebGL context lost', lastParams?.voxelSize, lastVoxelCount));
    return;
  }
  if (preview.inDetail) {
    detailPanel.resetAll(); // the detail scene died with the context; leave the detail view cleanly
    toast('The 3D view was reset after a graphics error; the open building detail was closed.', 'warn', 6000);
  }
  log.add('WebGL context lost; remounting the preview with a lighter render budget...', 'warn');
  void loadPreview();
}
/** Runs a recovery that had to wait for a load / detail job / open to finish. */
function flushRecovery(): void {
  if (!pendingRecovery || reloading || generating || detailBusy || opening || !lastVwgPath) return;
  pendingRecovery = false;
  recoverPreview();
}
preview.onContextLost = () => {
  if (!lastVwgPath) return;
  if (reloading || generating || detailBusy || opening) { // (a successful generate remounts anyway and clears this)
    // Never race a running load/detail job: the canvas is dead, say so now and recover when the job is done.
    pendingRecovery = true;
    showPreviewFailed('the graphics context was lost; the preview will reload when the current job finishes (or press "Reload preview").');
    return;
  }
  recoverPreview();
};

reloadBtn.addEventListener('click', () => {
  log.add('Reloading preview...');
  void loadPreview();
});

async function generate(): Promise<void> {
  if (generating || walking) return;
  const params = controls.readParams();
  if (!params) return;
  generating = true;
  refreshBusy();
  detailPanel.resetAll(); // leave the detail view and drop selection/photo state before the city is replaced
  detailPanel.setLocked(true);
  controls.setBusy(true);
  exporter.setEnabled(false);
  progress.reset();
  failedBox.hidden = true;
  log.add(`Generating (voxel ${params.voxelSize} m)...`);
  const before = { vwg: lastVwgPath, idx: lastIndexPath, params: lastParams, count: lastBuildingCount, name: exportName, shown: displayedWorldId };
  try {
    const res = await window.voxel.generate(params);
    const { vwgPath, stats } = res;
    progress.done(`Finished in ${(stats.elapsedMs / 1000).toFixed(1)} s`);
    progress.showStats(stats);
    log.add(`Generated ${stats.voxelCount.toLocaleString()} voxels in ${(stats.elapsedMs / 1000).toFixed(1)} s`);
    exportName = `voxelworld_${params.bbox.latMin.toFixed(3)}_${params.bbox.lonMin.toFixed(3)}`;
    exporter.setEnabled(true);

    lastVwgPath = vwgPath;
    lastIndexPath = stats.buildingIndexPath ?? null;
    lastParams = params;
    lastBuildingCount = stats.buildingCount;
    lastVoxelCount = stats.voxelCount;
    if (res.world && !res.saveError) {
      displayedWorldId = res.world.id;
      lastSourceInfo = res.world.sourceInfo;
      session.setCurrent(res.world);
      toast(`World saved: ${res.world.name}`);
    } else {
      displayedWorldId = null;
      session.clearCurrent();
      const why = res.saveError ?? 'no world was returned';
      toast(`World could not be saved: ${why}`, 'err', 8000);
      log.add(`World could not be saved: ${why}`, 'err');
    }
    tabs.show('preview'); // show first so the preview mounts into a sized container
    preview.resetDegrade();
    const status = await loadPreview();
    if (status === 'kept') { // the old city is still on screen: keep its context (export target, details)
      lastVwgPath = before.vwg; lastIndexPath = before.idx; lastParams = before.params; lastBuildingCount = before.count; exportName = before.name;
      displayedWorldId = before.shown;
    }
  } catch (e) {
    // A failed/cancelled generate leaves the previous city untouched: keep exporting and picking on it.
    if (cityShown && lastVwgPath) exporter.setEnabled(true);
    const msg = errorText(e);
    const m = /^([A-Z_]+): ([\s\S]*)$/.exec(msg);
    if (m && m[1] === 'CANCELLED') {
      progress.cancelled();
      log.add('Generation cancelled.', 'warn');
    } else {
      const friendly = m ? FRIENDLY_TITLES[m[1]!] : undefined;
      if (friendly) progress.fail('', `${friendly}. ${m![2]}`);
      else progress.fail(m ? m[1]! : 'ERROR', m ? m[2]! : msg);
      log.add(`Generation failed: ${msg}`, 'err');
    }
  } finally {
    generating = false;
    flushRecovery();
    refreshBusy();
    detailPanel.setLocked(false);
    controls.setBusy(false);
  }
}

const FRIENDLY_TITLES: Record<string, string> = {
  PBF_NO_COVERAGE: 'The chosen region does not cover this area',
  PBF_UNREADABLE: 'The local OSM data could not be read',
  DOWNLOAD_FAILED: 'The download failed',
  WORLD_NOT_FOUND: 'The saved world was not found',
};

/** Fills the generate form (and the map rectangle) with a saved world's parameters. */
function applyWorldParams(m: WorldMeta): void {
  controls.applyParams(m.params);
  const b = m.params?.bbox ?? m.bbox;
  if (b && Number.isFinite(b.latMin) && Number.isFinite(b.lonMax)) map.setBBox(b);
}

/** Opens a saved world exactly like a fresh generate: preview, building index, picking, HUD, export target. */
async function openWorld(meta: WorldMeta): Promise<void> {
  if (generating || detailBusy || opening || walking) return;
  opening = true;
  controls.setExternalBlock('Opening a world...');
  refreshBusy();
  detailPanel.setLocked(true);
  const prev = { vwg: lastVwgPath, idx: lastIndexPath, params: lastParams, count: lastBuildingCount, name: exportName, shown: displayedWorldId };
  try {
    const res = await window.voxel.openWorld(meta.id);
    lastVwgPath = res.vwgPath;
    lastIndexPath = res.buildingIndexPath ?? res.stats.buildingIndexPath ?? null;
    lastParams = { ...res.meta.params, bbox: res.meta.params?.bbox ?? res.meta.bbox };
    lastBuildingCount = res.stats.buildingCount;
    lastVoxelCount = res.stats.voxelCount;
    lastSourceInfo = res.meta.sourceInfo;
    exportName = `voxelworld_${res.meta.bbox.latMin.toFixed(3)}_${res.meta.bbox.lonMin.toFixed(3)}`;
    displayedWorldId = res.meta.id; // the building index (context for details) is read inside loadPreview
    tabs.show('preview');
    preview.resetDegrade(); // a different world: start from the full-quality budget for its size
    const status = await loadPreview(); // clears markers/buildings itself once the new scene is up
    if (status !== 'ok') {
      if (status === 'kept') { // old scene still on screen: restore its context
        lastVwgPath = prev.vwg; lastIndexPath = prev.idx; lastParams = prev.params; lastBuildingCount = prev.count; exportName = prev.name;
        displayedWorldId = prev.shown;
      } else {
        displayedWorldId = null;
        session.clearCurrent();
      }
      throw new Error('the world could not be shown (see the preview message)');
    }
    exporter.setEnabled(true);
    progress.showStats(res.stats);
    applyWorldParams(res.meta);
    session.setCurrent(res.meta);
    log.add(`Opened world "${res.meta.name}" (${res.stats.voxelCount.toLocaleString()} voxels)`);
  } catch (e) {
    const msg = errorText(e);
    log.add(`Open world failed: ${msg}`, 'err');
    toast(`Could not open the world: ${stripCode(msg)}`, 'err', 6000);
    void session.refreshWorlds();
  } finally {
    opening = false;
    flushRecovery();
    detailPanel.setLocked(false);
    controls.setExternalBlock(detailBusy ? 'A building detail job is running - cancel it first' : '');
    refreshBusy();
  }
}

// ───────────────────────── Walking demo ─────────────────────────
/** main-window-only helpers of the preload (not part of the frozen VoxelApi) */
type WalkApi = typeof window.voxel & { focusWalk?: () => Promise<void>; exitWalk?: () => Promise<void> };
const appRoot = $('app');
const walkLock = $('walk-lock');
const walkHere = $<HTMLButtonElement>('walk-here');
let walkBusy = false; // a startWalk call is in flight
let lockReturnFocus: Element | null = null;

/** Why "Walk here" cannot be used right now ('' = it can). */
function walkHereReason(): string {
  if (walking) return 'The walking view is open';
  if (walkBusy) return 'Opening the walking view...';
  if (generating || detailBusy || opening || reloading) return 'Wait for the running job to finish';
  if (!cityShown || !lastVwgPath) return 'Generate or open a world first';
  if (!displayedWorldId) return 'This world is not saved in the library (saving failed), so it cannot be walked';
  return '';
}
function syncWalkHere(): void {
  const why = walkHereReason();
  walkHere.disabled = !!why;
  walkHere.title = why || 'Walk through this world in a new window, starting at the view\u2019s ground position';
}

/** Applied from onWalkState (also the crash/kill path: main broadcasts false when the walk window is gone). */
function setWalking(active: boolean): void {
  if (active === walking) return;
  walking = active;
  if (active) {
    lockReturnFocus = document.activeElement;
    if (lockReturnFocus instanceof HTMLElement) lockReturnFocus.blur();
  }
  appRoot.toggleAttribute('inert', active); // no pointer, no keyboard, no focus anywhere in the app
  walkLock.hidden = !active;
  map.setLocked(active);
  detailPanel.setLocked(active || generating || opening);
  preview.setPaused(active);
  controls.setExternalBlock(active ? 'The walking view is open - close it to continue' : detailBusy ? 'A building detail job is running - cancel it first' : opening ? 'Opening a world...' : '');
  refreshBusy();
  syncWalkHere();
  if (active) $('walk-lock-focus').focus();
  else {
    if (lockReturnFocus instanceof HTMLElement && lockReturnFocus.isConnected) lockReturnFocus.focus();
    lockReturnFocus = null;
    if (tabs.current === 'map') requestAnimationFrame(() => map.refresh());
    flushRecovery();
  }
}

async function startWalk(worldId: string, spawn?: { x: number; z: number }): Promise<void> {
  if (walking || walkBusy) return;
  walkBusy = true;
  syncWalkHere();
  try {
    await window.voxel.startWalk(worldId, spawn);
    log.add('Walking view opened.');
  } catch (e) {
    const msg = errorText(e);
    log.add(`Walking view failed: ${msg}`, 'err');
    toast(`Could not open the walking view: ${stripCode(msg)}`, 'err', 6000);
  } finally {
    walkBusy = false;
    syncWalkHere();
  }
}

walkHere.addEventListener('click', () => {
  if (walkHereReason() || !displayedWorldId) return;
  const spot = preview.viewSpot();
  void startWalk(displayedWorldId, spot ?? undefined);
});
$('walk-lock-focus').addEventListener('click', () => void (window.voxel as WalkApi).focusWalk?.().catch(() => undefined));
// "Exit walking" from the locked main window: only main can close the walk window from here, via a dedicated channel.
$('walk-lock-exit').addEventListener('click', () => void (window.voxel as WalkApi).exitWalk?.().catch(() => undefined));
window.voxel.onWalkState(setWalking);

window.addEventListener('beforeunload', () => {
  session.dispose();
  source.geo.dispose();
  detailPanel.dispose();
  preview.dispose();
});
