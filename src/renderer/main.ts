import './dev/installMock'; // browser-only stub, no-op under Electron
import './ui/styles.css';
import type { GenerateParams } from '../shared/contract';
import { MapView } from './map/mapView';
import { Controls } from './ui/controls';
import { DetailPanel } from './ui/detailPanel';
import { $, errorText } from './ui/dom';
import { ExportPanel } from './ui/exportPanel';
import { LogPanel } from './ui/logPanel';
import { PreviewHost } from './ui/previewHost';
import { ProgressPanel } from './ui/progressPanel';
import { Tabs } from './ui/tabs';

const log = new LogPanel();
const progress = new ProgressPanel();
const tabs = new Tabs();
const preview = new PreviewHost($('preview-container'));
const detailPanel = new DetailPanel($('building-panel'), preview, (m, l) => log.add(m, l ?? 'info'));
preview.onPick = (hit) => detailPanel.handlePick(hit);
detailPanel.onBusy = (b) => controls.setExternalBlock(b ? 'A building detail job is running - cancel it first' : '');
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
let lastParams: GenerateParams | null = null;
let lastBuildingCount: number | undefined;
let reloading = false;
let previewDisposed = false;

let generating = false;
let exportName = 'voxelworld';

const controls = new Controls({
  onGenerate: () => void generate(),
  onCancel: () => {
    progress.setCancelling();
    log.add('Cancelling...', 'warn');
    void window.voxel.cancel();
  },
});
const map = new MapView($('map'), (b) => controls.setBBox(b));
const exporter = new ExportPanel((format) => {
  const t = detailPanel.activeExport() ?? (lastVwgPath ? { vwgPath: lastVwgPath, suffix: '' } : null);
  if (!t) return Promise.resolve(null);
  return window.voxel.exportAs(format, t.suffix ? `${exportName}_${t.suffix}` : exportName, t.vwgPath);
});

tabs.onChange((t) => {
  if (t === 'map') requestAnimationFrame(() => map.refresh());
});

// Sidebar bar is for generate only; analyze/detail progress goes to the detail panel's own bar.
window.voxel.onProgress((e) => { if (generating) progress.update(e); });
window.voxel.onWarning((e) => log.add(`[${e.code}] ${e.message}`, 'warn'));
window.voxel.onLog((line) => log.add(line, 'info'));

/** (Re)reads the last generated .vwg and mounts it; on failure shows a Reload button instead of a stale/blank view. */
async function loadPreview(): Promise<void> {
  if (!lastVwgPath || reloading) return;
  reloading = true;
  reloadBtn.disabled = true;
  failedBox.hidden = true;
  try {
    const buf = await window.voxel.readVwg(lastVwgPath);
    previewDisposed = true;
    preview.dispose(); // fresh scene/WebGL context on every (re)load
    await preview.load(buf);
    previewDisposed = false;
    detailPanel.clear(); // only once the new preview is up
    emptyHint.hidden = true;
    void loadBuildingIndex(lastVwgPath);
  } catch (e) {
    const msg = errorText(e);
    if (previewDisposed) detailPanel.clear(); // old scene is gone, selection is meaningless
    log.add(`Preview failed: ${msg}`, 'err');
    failedMsg.textContent = `Preview failed: ${msg}`;
    failedBox.hidden = false;
  } finally {
    reloading = false;
    reloadBtn.disabled = false;
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
    });
  } catch (e) {
    log.add(`Building index unavailable: ${errorText(e)}`, 'warn');
  }
}

reloadBtn.addEventListener('click', () => {
  log.add('Reloading preview...');
  void loadPreview();
});

async function generate(): Promise<void> {
  if (generating) return;
  const params = controls.readParams();
  if (!params) return;
  generating = true;
  detailPanel.resetAll(); // leave the detail view and drop selection/photo state before the city is replaced
  detailPanel.setLocked(true);
  controls.setBusy(true);
  exporter.setEnabled(false);
  progress.reset();
  failedBox.hidden = true;
  log.add(`Generating (voxel ${params.voxelSize} m)...`);
  try {
    const { vwgPath, stats } = await window.voxel.generate(params);
    progress.done(`Finished in ${(stats.elapsedMs / 1000).toFixed(1)} s`);
    progress.showStats(stats);
    log.add(`Generated ${stats.voxelCount.toLocaleString()} voxels in ${(stats.elapsedMs / 1000).toFixed(1)} s`);
    exportName = `voxelworld_${params.bbox.latMin.toFixed(3)}_${params.bbox.lonMin.toFixed(3)}`;
    exporter.setEnabled(true);

    lastVwgPath = vwgPath;
    lastIndexPath = stats.buildingIndexPath ?? null;
    lastParams = params;
    lastBuildingCount = stats.buildingCount;
    tabs.show('preview'); // show first so the preview mounts into a sized container
    await loadPreview();
  } catch (e) {
    const msg = errorText(e);
    const m = /^([A-Z_]+): ([\s\S]*)$/.exec(msg);
    if (m && m[1] === 'CANCELLED') {
      progress.cancelled();
      log.add('Generation cancelled.', 'warn');
    } else {
      progress.fail(m ? m[1] : 'ERROR', m ? m[2] : msg);
      log.add(`Generation failed: ${msg}`, 'err');
    }
  } finally {
    generating = false;
    detailPanel.setLocked(false);
    controls.setBusy(false);
  }
}

window.addEventListener('beforeunload', () => {
  detailPanel.dispose();
  preview.dispose();
});
