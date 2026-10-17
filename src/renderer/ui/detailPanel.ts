import type { BBox, BuildingIndex, BuildingInfo, DetailParams, DetailStats } from '../../shared/contract';
import { clampWall, estimateDetailVoxels, wallSizeError } from '../detail/spec';
import { BuildingGrid, edgeLength, pickFromHit } from '../pick/geometry';
import { parseDecimal } from './controls';
import { errorText } from './dom';
import { FacadeEditor } from './facadeEditor';
import { h, field, num } from './h';
import { PhotoQuadEditor } from './photoEditor';
import type { PreviewHost, SurfaceHit } from './previewHost';

export interface DetailContext {
  bbox: BBox;
  /** Generate-form values the shown city was built with (sent in DetailParams.ref). */
  metersPerFloor: number;
  defaultBuildingHeight: number;
  cityVwgPath: string;
  /** Buildings the generate reported (GenerateStats.buildingCount); the index only lists detailable ones. */
  buildingCount?: number;
}
export const DETAIL_MAX_VOXELS_DEFAULT = 20_000_000;
export const DETAIL_MAX_VOXELS_MIN = 1_000_000;
export const DETAIL_MAX_VOXELS_MAX = 30_000_000;

/** Parse the "Max voxels (M)" field: voxel count within 1..30 M, else null. */
export function parseDetailMaxVoxels(text: string): number | null {
  const m = parseDecimal(text);
  if (m === null) return null;
  const v = Math.round(m * 1e6);
  return v >= DETAIL_MAX_VOXELS_MIN && v <= DETAIL_MAX_VOXELS_MAX ? v : null;
}

/** Gentle memory note for very fine interiors, else null. */
export function detailMemoryHint(voxelSize: number, interiorOn: boolean): string | null {
  return interiorOn && voxelSize > 0 && voxelSize < 0.1 ? 'Interiors below 0.1 m voxels may need several GB of memory.' : null;
}

/** Eave height estimate: levels * metersPerFloor when levels are known, else 85% of the total height (roof rise). */
export function eaveHeight(b: { levels: number; heightM: number }, metersPerFloor: number): number {
  const est = b.levels > 0 ? b.levels * metersPerFloor : b.heightM * 0.85;
  return Math.max(1, b.heightM > 0 ? Math.min(est, b.heightM) : est);
}
/** Plain-language text for photo failures (main/python report e.g. "PHOTO_UNREADABLE: ... 150.0 MP ..."). */
export function friendlyPhotoError(raw: string): string {
  const m = raw.replace(/^[A-Z_]+:\s*/, '');
  if (/megapixel|\bMP\b|too large|too big|pixel|decompression|exceeds|size limit|bytes/i.test(m)) {
    return 'Photo is too large (over 100 megapixels). Choose a smaller image.';
  }
  if (/unsupported|format|decode|corrupt|truncated|cannot identify|not an image|invalid/i.test(m)) {
    return 'This file is not a readable image. Use a JPG, PNG or WebP photo.';
  }
  if (/^PHOTO_UNREADABLE/.test(raw) || /unreadable|could not be read|cannot read/i.test(m)) {
    return 'The photo could not be read. Choose another file.';
  }
  return m || 'The photo could not be loaded.';
}

type Log = (msg: string, level?: 'info' | 'warn' | 'err') => void;

const DEFAULT_DETAIL_VOXEL = 0.15;

/** Right-hand overlay in the 3D tab: picked-building info, photo facade, interior options, detail generation + cutaway. */
export class DetailPanel {
  /** Fired when a detail/analyze job starts or ends (main uses it to block the sidebar Generate button). */
  onBusy: (busy: boolean) => void = () => {};

  private grid: BuildingGrid | null = null;
  private ctx: DetailContext | null = null;
  private building: BuildingInfo | null = null;
  private edge = -1;
  private busy = false;
  private locked = false; // set while a city generate runs
  private formOpen = false;
  private photo: { path: string } | null = null;
  private lastStats: DetailStats | null = null;
  private detailPath: string | null = null;
  private specStale = false;
  private analysedEdge = -1;
  private applyWanted = false;
  private cancelling = false;
  private unsub: (() => void) | null = null;
  private rewarpRaf = 0;

  // sticky top: title, collapse, wall switcher, job strip
  private readonly title = h('h2', { text: 'Building' });
  private readonly collapseBtn = h('button', { class: 'bp-collapse', text: '–', title: 'Collapse panel' });
  private readonly edgeRow = h('div', { class: 'row bp-edge' });
  private readonly edgeLabel = h('span', { class: 'muted' });
  private readonly jobMsg = h('div', { class: 'bp-job-msg' });
  private readonly jobBar = h('div', { id: 'detail-bar' });
  private readonly jobPct = h('span', { class: 'muted' });
  private readonly cancel = h('button', { class: 'bp-cancel', text: 'Cancel' });
  private readonly job = h('div', { class: 'bp-job', hidden: true },
    this.jobMsg, h('div', { class: 'bar' }, this.jobBar), h('div', { class: 'bp-job-row' }, this.jobPct, this.cancel));
  // building info (fixed rows: no layout jump on selection)
  private readonly kv: Record<'id' | 'kind' | 'name' | 'levels' | 'height', HTMLElement> = {
    id: h('b', { text: '-' }), kind: h('b', { text: '-' }), name: h('b', { text: '-' }), levels: h('b', { text: '-' }), height: h('b', { text: '-' }),
  };
  private readonly count = h('div', { class: 'muted bp-count' });
  private readonly detailBtn = h('button', { class: 'primary', text: 'Detail this building', disabled: true });
  // detail form
  private readonly form = h('div');
  private readonly choose = h('button', { text: 'Choose photo...' });
  private readonly photoErr = h('div', { class: 'warn err', hidden: true });
  private readonly photoName = h('div', { class: 'muted', text: 'No photo.' });
  private readonly photoEd = new PhotoQuadEditor();
  private readonly facade = new FacadeEditor();
  private readonly wallW = num('', 'Wall width in metres');
  private readonly wallH = num('', 'Wall height in metres');
  private readonly wallNote = h('div', { class: 'warn', hidden: true });
  private readonly quadNote = h('div', { class: 'warn err', hidden: true });
  private readonly analyze = h('button', { text: 'Analyze', disabled: true });
  private readonly analysisNote = h('div', { class: 'muted bp-analysis', hidden: true });
  private readonly useFacade = h('input', { type: 'checkbox', disabled: true });
  private readonly useFacadeLbl = h('label', { class: 'check bp-apply' }, this.useFacade, 'Apply facade to the selected wall');
  private readonly interior = h('input', { type: 'checkbox' });
  private readonly wallT = num(0.2, 'Wall thickness in metres');
  private readonly roomMin = num(2.5, 'Minimum room size in metres');
  private readonly seed = num(1, 'Seed');
  private readonly voxel = num(DEFAULT_DETAIL_VOXEL, 'Detail voxel size in metres');
  private readonly maxVox = num(DETAIL_MAX_VOXELS_DEFAULT / 1e6, 'Detail max voxels in millions');
  private readonly estimate = h('div', { class: 'muted' });
  private readonly warn = h('div', { class: 'warn err', hidden: true });
  private readonly memHint = h('div', { class: 'warn', hidden: true });
  private readonly generate = h('button', { class: 'primary', text: 'Generate detail', disabled: true });
  private readonly status = h('div', { class: 'muted bp-status' });
  // detail view section
  private readonly viewStats = h('div', { class: 'muted' });
  private readonly slider = h('input', { type: 'range', min: '0', max: '1', step: '1', value: '1' });
  private readonly sliderLbl = h('span', { class: 'muted' });
  private readonly sliderField = h('div', { class: 'field' }, h('span', {}, 'Floor cutaway', this.sliderLbl), this.slider);
  private readonly back = h('button', { text: 'Back to city', class: 'primary' });
  private readonly sBuilding: HTMLElement;
  private readonly sDetail: HTMLElement;
  private readonly sView: HTMLElement;
  private readonly body: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly preview: PreviewHost, private readonly log: Log) {
    const sec = (...kids: Array<Node | null>): HTMLElement => h('section', { class: 'panel' }, ...kids);
    const prev = h('button', { text: '<', title: 'Previous wall' });
    const next = h('button', { text: '>', title: 'Next wall' });
    prev.addEventListener('click', () => this.cycleEdge(-1));
    next.addEventListener('click', () => this.cycleEdge(1));
    this.edgeRow.append(prev, this.edgeLabel, next);
    this.wallH.title = 'Eave height (editable). Defaults to levels x metres/floor.';
    this.seed.title = 'Random seed';
    this.wallT.title = 'Exterior wall thickness (m)';
    this.roomMin.title = 'Minimum room size (m)';

    const kvRow = (k: string, v: HTMLElement): HTMLElement => h('div', { class: 'kv' }, h('span', { class: 'muted', text: k }), v);
    this.sBuilding = sec(
      kvRow('ID', this.kv.id), kvRow('Kind', this.kv.kind), kvRow('Name', this.kv.name),
      kvRow('Levels', this.kv.levels), kvRow('Height', this.kv.height), this.count,
      h('div', { class: 'row buttons' }, this.detailBtn),
    );

    const photoSec = h('details', { class: 'bp-details', open: true },
      h('summary', { text: 'Photo facade' }),
      h('div', { class: 'row buttons bp-choose' }, this.choose),
      this.photoErr,
      this.photoName,
      this.photoEd.el,
      h('div', { class: 'row bp-wall' }, field('Wall width (m)', this.wallW), field('Wall height (m)', this.wallH)),
      this.wallNote, this.quadNote,
      h('div', { class: 'row buttons' }, this.analyze),
      this.analysisNote,
      this.facade.el,
      this.useFacadeLbl,
    );
    const interiorSec = h('details', { class: 'bp-details' },
      h('summary', { text: 'Interior' }),
      h('label', { class: 'check' }, this.interior, 'Generate interior'),
      h('div', { class: 'row bp-int' }, field('Wall (m)', this.wallT), field('Room (m)', this.roomMin), field('Seed', this.seed)),
    );
    this.form.append(
      photoSec, interiorSec,
      h('div', { class: 'bp-gen' },
        h('div', { class: 'row' }, field('Voxel size (m)', this.voxel), field('Max voxels (M)', this.maxVox)),
        this.estimate, this.memHint, this.warn, h('div', { class: 'row buttons' }, this.generate), this.status),
    );
    this.sDetail = sec(h('h2', { text: 'Detail' }), this.form);
    this.sView = sec(
      this.viewStats, this.sliderField,
      h('div', { class: 'row buttons' }, this.back),
      h('div', { class: 'muted', text: 'Sidebar export writes this detail scene while it is shown.' }),
    );
    this.body = h('div', { class: 'bp-body' }, this.sBuilding, this.sDetail, this.sView);
    const top = h('div', { class: 'bp-top' }, h('div', { class: 'bp-head' }, this.title, this.collapseBtn), this.edgeRow, this.job);
    root.append(top, this.body);
    root.hidden = true;
    this.showMode('browse');
    this.setInteriorEnabled();
    this.renderInfo();

    this.collapseBtn.addEventListener('click', () => {
      const c = root.classList.toggle('collapsed');
      root.parentElement?.classList.toggle('panel-collapsed', c);
      this.collapseBtn.textContent = c ? '+' : '–';
      this.collapseBtn.title = c ? 'Expand panel' : 'Collapse panel';
    });
    this.detailBtn.addEventListener('click', () => {
      this.formOpen = true;
      this.showMode('browse');
      this.photoEd.layout();
      this.sDetail.scrollIntoView({ block: 'nearest' });
    });
    this.choose.addEventListener('click', () => void this.pickPhoto());
    this.analyze.addEventListener('click', () => void this.runAnalyze());
    for (const el of [this.voxel, this.maxVox, this.wallT, this.roomMin]) el.addEventListener('input', () => this.updateEstimate());
    this.interior.addEventListener('change', () => { this.setInteriorEnabled(); this.updateEstimate(); });
    const wallChanged = (): void => {
      const w = parseDecimal(this.wallW.value), hh = parseDecimal(this.wallH.value);
      if (w && hh && !wallSizeError(w, hh)) { this.facade.setWallSize(w, hh); this.scheduleRewarp(false); }
      this.syncQuad();
      this.updateEstimate();
    };
    for (const el of [this.wallW, this.wallH]) {
      el.addEventListener('change', wallChanged); // rescales the spec only when editing is committed
      el.addEventListener('input', () => { this.syncQuad(); this.updateEstimate(); }); // live validation only
    }
    this.photoEd.onChange = (final) => {
      this.scheduleRewarp(!final);
      this.syncQuad();
    };
    this.useFacade.addEventListener('change', () => {
      if (this.useFacade.checked && this.specStale) {
        this.useFacade.checked = false;
        this.status.textContent = 'Re-analyze the photo for the new wall before applying the facade.';
      }
    });
    this.generate.addEventListener('click', () => void this.runDetail());
    this.cancel.addEventListener('click', () => {
      if (this.cancelling) return;
      this.cancelling = true;
      this.cancel.disabled = true;
      this.cancel.textContent = 'Cancelling...';
      this.jobMsg.textContent = 'Cancelling...';
      this.jobPct.textContent = '';
      void window.voxel.cancel().catch(() => undefined);
    });
    this.back.addEventListener('click', () => this.backToCity());
    this.slider.addEventListener('input', () => this.applyCut());
    this.unsub = window.voxel.onProgress((e) => {
      if (!this.busy || this.cancelling) return; // progress only drives the pinned job strip
      this.jobMsg.textContent = `${e.stage}: ${e.message}`;
      this.jobBar.style.width = `${Math.max(0, Math.min(100, e.pct))}%`;
      this.jobPct.textContent = e.pct > 0 ? `${Math.round(e.pct)}%` : '';
    });
  }

  // ---- lifecycle

  /** Called after each generate with the freshly read index. */
  setIndex(index: BuildingIndex, ctx: DetailContext): void {
    this.clear();
    this.ctx = ctx;
    this.grid = new BuildingGrid(index.buildings);
    this.root.hidden = false;
    this.root.parentElement?.classList.add('has-panel');
    this.renderInfo();
  }

  /** Leave the detail view and forget the selection, photo, spec and options. Keeps the index (old city stays pickable). */
  resetAll(): void {
    if (this.inDetail) {
      this.preview.backToCity();
      this.preview.setCutaway(null);
    }
    this.lastStats = null;
    this.detailPath = null;
    this.building = null;
    this.edge = -1;
    this.formOpen = false;
    this.endJob('');
    this.resetBuildingState();
    this.preview.setHighlight(null);
    this.showMode('browse');
    this.renderInfo();
  }

  clear(): void {
    this.resetAll();
    this.grid = null;
    this.ctx = null;
    this.busy = false;
    this.root.hidden = true;
    this.root.parentElement?.classList.remove('has-panel');
    this.renderInfo();
  }

  /** Block detail actions while a city generate runs (backend has one job slot). */
  setLocked(v: boolean): void {
    this.locked = v;
    this.syncQuad();
    this.updateEstimate();
    this.detailBtn.disabled = !this.building || this.busy || this.locked;
  }

  dispose(): void {
    this.unsub?.();
    cancelAnimationFrame(this.rewarpRaf);
    this.photoEd.dispose();
    this.facade.dispose();
  }

  get inDetail(): boolean { return !this.sView.hidden; }
  private get blocked(): boolean { return this.busy || this.locked; }

  private showMode(m: 'browse' | 'detail'): void {
    const detail = m === 'detail';
    this.sBuilding.hidden = detail;
    this.sDetail.hidden = detail || !this.formOpen;
    this.sView.hidden = !detail;
    this.edgeRow.hidden = detail || !this.building;
    this.title.textContent = detail ? 'Detail view' : 'Building';
  }

  /** Photo, spec, interior and apply state are per building. */
  private resetBuildingState(): void {
    this.photo = null;
    this.photoName.textContent = 'No photo.';
    this.photoErr.hidden = true;
    this.photoEd.el.hidden = true;
    this.photoEd.img = null;
    this.facade.el.hidden = true;
    this.facade.spec = null;
    this.specStale = false;
    this.analysedEdge = -1;
    this.applyWanted = false;
    this.wallNote.hidden = true;
    this.quadNote.hidden = true;
    this.analysisNote.hidden = true;
    this.analyze.disabled = true;
    this.useFacade.checked = false;
    this.useFacade.disabled = true;
    this.interior.checked = false;
    this.setInteriorEnabled();
    this.status.textContent = '';
    this.warn.hidden = true;
    this.updateEstimate();
  }

  private setInteriorEnabled(): void {
    const on = this.interior.checked;
    for (const el of [this.wallT, this.roomMin, this.seed]) el.disabled = !on;
  }

  // ---- pinned job strip

  private startJob(msg: string): void {
    this.busy = true;
    this.cancelling = false;
    this.cancel.disabled = false;
    this.cancel.textContent = 'Cancel';
    this.jobMsg.textContent = msg;
    this.jobBar.style.width = '0%';
    this.jobPct.textContent = '';
    this.job.hidden = false;
    this.root.scrollTop = 0; // the strip is sticky, but make sure the top is in view
    this.syncAll();
    this.onBusy(true);
  }

  /** `final` is shown in the status line (errors / cancelled); progress text never lingers there. */
  private endJob(final: string): void {
    const was = this.busy;
    this.busy = false;
    this.cancelling = false;
    this.job.hidden = true;
    this.status.textContent = final;
    this.syncAll();
    if (was) this.onBusy(false);
  }

  private syncAll(): void {
    this.syncQuad();
    this.updateEstimate();
    this.choose.disabled = this.blocked;
    this.detailBtn.disabled = !this.building || this.blocked;
  }

  // ---- picking / selection

  handlePick(hit: SurfaceHit | null): void {
    if (!this.grid || this.blocked || this.inDetail || !hit) return; // misses never reset the selection
    const r = pickFromHit(this.grid, hit.p, hit.n);
    if (!r) return;
    this.select(r.building, r.edge);
  }

  private select(b: BuildingInfo, edge: number): void {
    const differentBuilding = b.id !== this.building?.id;
    const edgeChanged = !differentBuilding && edge !== this.edge;
    this.building = b;
    this.edge = edge;
    if (differentBuilding) {
      this.formOpen = false;
      this.resetBuildingState();
    } else if (edgeChanged) {
      this.onEdgeChanged();
    }
    this.showMode('browse');
    this.syncHighlight();
    this.renderInfo();
    this.syncWallFields();
    this.updateEstimate();
  }

  /**
   * Same building, different wall. The analysed spec only describes `analysedEdge`: on another wall it is stale
   * (Apply off, note shown, nothing rescaled); coming back to the analysed wall restores it.
   */
  private onEdgeChanged(): void {
    if (!this.facade.spec) return;
    if (this.edge === this.analysedEdge) {
      this.specStale = false;
      this.wallNote.hidden = true;
      this.useFacade.checked = this.applyWanted;
      return;
    }
    if (!this.specStale) this.applyWanted = this.useFacade.checked;
    this.specStale = true;
    this.useFacade.checked = false;
    this.wallNote.textContent = 'Wall changed - re-mark corners (and re-analyze) for the new wall. Old windows are not rescaled.';
    this.wallNote.hidden = false;
  }

  private cycleEdge(d: number): void {
    const b = this.building;
    if (!b || this.blocked) return;
    this.edge = (this.edge + d + b.footprint.length) % b.footprint.length;
    this.onEdgeChanged();
    this.syncHighlight();
    this.renderInfo();
    this.syncWallFields();
  }

  private syncHighlight(): void {
    const b = this.building;
    this.preview.setHighlight(b ? { footprint: b.footprint, baseY: b.baseY, topY: b.topY, edge: this.edge } : null);
  }

  private edgeM(): number {
    const b = this.building;
    return b && this.edge >= 0 ? edgeLength(b.footprint, this.edge) * this.preview.voxelSize : 0;
  }

  private syncWallFields(): void {
    const b = this.building;
    if (!b || this.edge < 0) return;
    this.wallW.value = clampWall(this.edgeM()).toFixed(2);
    const total = b.heightM > 0 ? b.heightM : (b.topY - b.baseY) * this.preview.voxelSize;
    this.wallH.value = clampWall(eaveHeight({ levels: b.levels, heightM: total }, this.ctx?.metersPerFloor ?? 3.5)).toFixed(2);
    this.syncQuad();
  }

  private renderInfo(): void {
    const b = this.building, k = this.kv;
    k.id.textContent = b?.id ?? '-';
    k.kind.textContent = b?.kind ?? '-';
    k.name.textContent = b?.name ?? '-';
    k.levels.textContent = b ? String(b.levels) : '-';
    k.height.textContent = b ? `${b.heightM.toFixed(1)} m` : '-';
    if (this.grid) {
      const n = this.grid.count, total = this.ctx?.buildingCount;
      this.count.textContent = total !== undefined && total !== n
        ? `${n.toLocaleString()} of ${total.toLocaleString()} buildings can be detailed (the rest lack a usable footprint). Click one to select it (fly mode: F).`
        : `${n.toLocaleString()} buildings. Click one to select it (fly mode: F).`;
    } else this.count.textContent = '';
    this.edgeRow.hidden = this.inDetail || !b;
    if (b) this.edgeLabel.textContent = `Wall ${this.edge + 1}/${b.footprint.length} - ${this.edgeM().toFixed(1)} m`;
    this.detailBtn.disabled = !b || this.blocked;
  }

  // ---- photo

  private async pickPhoto(): Promise<void> {
    this.photoErr.hidden = true;
    try {
      const p = await window.voxel.pickPhoto();
      if (!p) return;
      await this.photoEd.load(p.previewUrl); // throws before replacing the current photo if undecodable
      this.photo = { path: p.photoPath };
      this.photoName.textContent = p.photoPath.split(/[\\/]/).pop() ?? p.photoPath;
      this.facade.el.hidden = true;
      this.facade.spec = null;
      this.specStale = false;
      this.analysedEdge = -1;
      this.wallNote.hidden = true;
      this.analysisNote.hidden = true;
      this.useFacade.checked = false;
      this.useFacade.disabled = true;
      this.photoErr.hidden = true;
      this.syncQuad();
    } catch (e) {
      this.showPhotoError(errorText(e)); // previous photo (if any) stays as it was
    }
  }

  private showPhotoError(raw: string): void {
    const msg = friendlyPhotoError(raw);
    this.photoErr.textContent = msg;
    this.photoErr.hidden = false;
    this.log(`Photo: ${raw}`, 'err');
  }

  private wallError(): string | null {
    return wallSizeError(parseDecimal(this.wallW.value), parseDecimal(this.wallH.value));
  }

  /** Validate the marked quad + wall size: show the reason and disable Analyze when unusable. */
  private syncQuad(): void {
    const wallMsg = this.photo || this.facade.spec ? this.wallError() : null;
    this.wallW.classList.toggle('invalid', !!wallMsg);
    this.wallH.classList.toggle('invalid', !!wallMsg);
    const msg = (this.photo ? this.photoEd.validate() : null) ?? wallMsg;
    this.quadNote.textContent = msg ?? '';
    this.quadNote.hidden = !msg;
    this.analyze.disabled = this.blocked || !this.photo || msg !== null;
  }

  /** At most one warp per frame; low-res while a handle is being dragged, full-res once released. */
  private scheduleRewarp(lowRes: boolean): void {
    cancelAnimationFrame(this.rewarpRaf);
    this.rewarpRaf = requestAnimationFrame(() => {
      if (this.photoEd.img && this.facade.spec) this.facade.setPhoto(this.photoEd.img, this.photoEd.getCorners(), lowRes);
    });
  }

  private async runAnalyze(): Promise<void> {
    const b = this.building;
    if (!b || !this.photo || this.blocked || this.photoEd.validate()) return;
    const w = parseDecimal(this.wallW.value), hh = parseDecimal(this.wallH.value);
    const werr = wallSizeError(w, hh);
    if (werr || !w || !hh) { this.status.textContent = werr ?? 'Enter wall width and height in metres.'; return; }
    this.photoErr.hidden = true;
    this.analysisNote.hidden = true;
    this.startJob('Analyzing photo...');
    let final = '';
    try {
      const res = await window.voxel.analyzeFacade({
        photoPath: this.photo.path, corners: this.photoEd.getCorners(), wallWidthM: w, wallHeightM: hh, floorsHint: b.levels,
      });
      this.facade.setSpec(res.spec);
      this.specStale = false;
      this.analysedEdge = this.edge;
      this.wallNote.hidden = true;
      this.useFacade.disabled = false;
      this.useFacade.checked = true;
      this.applyWanted = true;
      this.analysisNote.textContent = 'Analysis done. Review and correct the overlay.';
      this.analysisNote.hidden = false;
      this.scheduleRewarp(false);
    } catch (e) {
      final = this.explain(e);
      if (/^PHOTO_UNREADABLE/.test(errorText(e))) { this.showPhotoError(errorText(e)); final = ''; }
      this.log(`Analyze failed: ${errorText(e)}`, 'err');
    } finally {
      this.endJob(final);
    }
  }

  // ---- detail generation

  private interiorOptions() {
    return {
      enabled: this.interior.checked,
      wallThicknessM: parseDecimal(this.wallT.value) ?? 0.2,
      roomMinM: parseDecimal(this.roomMin.value) ?? 2.5,
      seed: Math.round(parseDecimal(this.seed.value) ?? 1),
    };
  }

  /** Detail's own voxel cap (1..30 M), not the city limit. */
  private maxVoxels(): number | null {
    return parseDetailMaxVoxels(this.maxVox.value);
  }

  private updateEstimate(): void {
    const b = this.building, v = parseDecimal(this.voxel.value), mv = this.maxVoxels();
    const ok = !!b && !!v && v >= 0.05 && v <= 0.5 && !!this.ctx && mv !== null;
    const mem = detailMemoryHint(v ?? 0, this.interior.checked);
    this.memHint.hidden = !b || !mem;
    this.memHint.textContent = mem ?? '';
    this.maxVox.classList.toggle('invalid', !!b && mv === null);
    this.voxel.classList.toggle('invalid', !!b && !ok);
    this.generate.disabled = !ok || this.blocked || (!!this.facade.spec && this.wallError() !== null);
    if (!b || !ok || !v || !this.ctx || mv === null) {
      this.estimate.textContent = !b ? '' : mv === null ? `Max voxels must be ${DETAIL_MAX_VOXELS_MIN / 1e6} - ${DETAIL_MAX_VOXELS_MAX / 1e6} M.` : 'Voxel size must be 0.05 - 0.5 m.';
      this.warn.hidden = true;
      return;
    }
    const n = estimateDetailVoxels(b, this.preview.voxelSize, v, this.interiorOptions());
    const over = n > mv;
    this.estimate.textContent = over
      ? `Estimated ~${n.toLocaleString()} voxels - over the limit`
      : `Estimated ~${n.toLocaleString()} voxels (limit ${mv.toLocaleString()})`;
    this.warn.hidden = !over;
    if (over) this.warn.textContent = `Over the ${mv.toLocaleString()} voxel limit; the build will likely fail with VOXEL_LIMIT. Increase the voxel size or the limit.`;
  }

  private explain(e: unknown): string {
    const m = errorText(e);
    if (/^BUSY/.test(m)) return 'Another job is running. Wait for it to finish.';
    if (/^CANCELLED/.test(m)) return 'Cancelled.';
    if (/^PHOTO_UNREADABLE/.test(m)) return friendlyPhotoError(m);
    return m;
  }

  private async runDetail(): Promise<void> {
    const b = this.building, ctx = this.ctx, v = parseDecimal(this.voxel.value), mv = this.maxVoxels();
    if (!b || !ctx || !v || mv === null || this.blocked) return;
    if (this.facade.spec && this.wallError()) return;
    const spec = this.useFacade.checked && !this.specStale ? this.facade.getSpec() : null;
    const params: DetailParams = {
      ref: { bbox: ctx.bbox, buildingId: b.id, metersPerFloor: ctx.metersPerFloor, defaultBuildingHeight: ctx.defaultBuildingHeight },
      voxelSize: v,
      facade: spec && this.edge >= 0 ? { edge: this.edge, spec } : undefined,
      interior: this.interiorOptions(),
      maxVoxels: mv,
    };
    this.startJob('Generating detail...');
    let final = '';
    try {
      const res = await window.voxel.detail(params);
      const buf = await window.voxel.readVwg(res.vwgPath);
      this.preview.showDetail(buf);
      this.detailPath = res.vwgPath;
      this.enterDetailView(b, res.stats);
      this.log(`Detail ${b.id}: ${res.stats.voxelCount.toLocaleString()} voxels in ${(res.stats.elapsedMs / 1000).toFixed(1)} s`);
    } catch (e) {
      final = this.explain(e);
      this.log(`Detail failed: ${errorText(e)}`, 'err');
    } finally {
      this.endJob(final);
    }
  }

  private enterDetailView(b: BuildingInfo, s: DetailStats): void {
    this.lastStats = s;
    this.showMode('detail');
    this.viewStats.textContent =
      `${b.id}: ${s.voxelCount.toLocaleString()} voxels, ${s.levels} levels, ${s.rooms} rooms, ${s.windows} windows, ${s.doors} doors`;
    const n = s.floorYs.length;
    this.sliderField.hidden = n === 0;
    this.slider.max = String(n);
    this.slider.value = String(n);
    this.applyCut();
  }

  /** v = n: whole building; 0 < v < n: levels 1..v (cut just below slab v); v = 0: ground slab only. */
  private applyCut(): void {
    const ys = this.lastStats?.floorYs ?? [];
    const n = ys.length, v = Number(this.slider.value);
    if (v >= n) {
      this.preview.setCutaway(null);
      this.sliderLbl.textContent = ' whole building';
    } else {
      this.preview.setCutaway(v === 0 ? ys[0]! : ys[v]! - 1);
      this.sliderLbl.textContent = v === 0 ? ' ground slab only' : ` levels 1-${v}`;
    }
  }

  private backToCity(): void {
    this.preview.backToCity();
    this.preview.setCutaway(null);
    this.lastStats = null;
    this.detailPath = null;
    this.wallNote.hidden = true;
    this.photoErr.hidden = true;
    this.status.textContent = '';
    this.showMode('browse');
    this.photoEd.layout();
    this.renderInfo();
  }

  /** What sidebar export should write: the detail scene while viewing it, else the city. */
  activeExport(): { vwgPath: string; suffix: string } | null {
    if (this.inDetail && this.detailPath) return { vwgPath: this.detailPath, suffix: (this.building?.id ?? 'detail').replace(/[^\w.-]+/g, '_') };
    return this.ctx ? { vwgPath: this.ctx.cityVwgPath, suffix: '' } : null;
  }
}
