import type { BBox, GenerateParams } from '../../shared/contract';
import { INT32_AXIS_LIMIT, INT32_FLAT_LIMIT, estimateBBox, fmtCount } from '../map/estimate';
import { $ } from './dom';

const TOKEN_KEY = 'voxelworlds.mapillaryToken';
const SETTINGS_KEY = 'voxelworlds.settings';
export const DEFAULT_MAX_VOXELS = 50_000_000;
export const VOXEL_MIN = 0.05;
export const VOXEL_MAX = 5;

/** Slider index -> voxel size: 0.05 m steps up to 1 m (idx 0..19), then 0.25 m steps to 5 m (idx 20..35). */
export function sliderToSize(i: number): number {
  return i <= 19 ? Math.round((i + 1) * 5) / 100 : 1 + (i - 19) * 0.25;
}
export function sizeToSlider(v: number): number {
  const i = v <= 1 ? Math.round(v / 0.05) - 1 : 19 + Math.round((v - 1) / 0.25);
  return Math.max(0, Math.min(35, i));
}
function fmtSize(v: number): string {
  return String(Number(v.toFixed(3)));
}

/** Accepts '3.5' and '3,5'; rejects empty, thousands separators and garbage. */
export function parseDecimal(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

export class Controls {
  private size = $<HTMLInputElement>('voxel-size');
  private sizeNum = $<HTMLInputElement>('voxel-size-num');
  private tile = $<HTMLInputElement>('tile-size');
  private workers = $<HTMLInputElement>('workers');
  private maxVox = $<HTMLInputElement>('max-voxels');
  private maxVoxHint = $('max-voxels-hint');
  private token = $<HTMLInputElement>('mapillary-token');
  private roads = $<HTMLInputElement>('opt-roads');
  private elevation = $<HTMLInputElement>('opt-elevation');
  private facades = $<HTMLInputElement>('opt-facades');
  private mpf = $<HTMLInputElement>('meters-per-floor');
  private height = $<HTMLInputElement>('default-height');
  private btnGenerate = $<HTMLButtonElement>('btn-generate');
  private btnCancel = $<HTMLButtonElement>('btn-cancel');
  private info = $('bbox-info');
  private warn = $('bbox-warn');
  private reason = $('gen-reason');
  private genRow = $('gen-row');
  private paramsError = $('params-error');
  private bbox: BBox | null = null;
  private busy = false;
  private cancelling = false;
  private tooBig = false;
  private blocked = '';
  private external = '';
  private voxelSize = 1;

  constructor(handlers: { onGenerate(): void; onCancel(): void }) {
    this.token.value = localStorage.getItem(TOKEN_KEY) ?? '';
    this.token.addEventListener('input', () => localStorage.setItem(TOKEN_KEY, this.token.value.trim()));
    this.loadSettings();
    this.size.addEventListener('input', () => {
      this.voxelSize = sliderToSize(Number(this.size.value));
      this.sizeNum.value = fmtSize(this.voxelSize);
      this.onSettingChanged();
    });
    this.sizeNum.addEventListener('input', () => {
      const v = parseDecimal(this.sizeNum.value);
      if (v !== null && v >= VOXEL_MIN && v <= VOXEL_MAX) {
        this.voxelSize = v;
        this.size.value = String(sizeToSlider(v));
      }
      this.onSettingChanged();
    });
    this.sizeNum.addEventListener('blur', () => {
      const v = parseDecimal(this.sizeNum.value);
      if (v === null) this.sizeNum.value = fmtSize(this.voxelSize);
      else {
        this.voxelSize = Math.max(VOXEL_MIN, Math.min(VOXEL_MAX, v));
        this.sizeNum.value = fmtSize(this.voxelSize);
        this.size.value = String(sizeToSlider(this.voxelSize));
      }
      this.onSettingChanged();
    });
    for (const el of [this.tile, this.workers, this.maxVox]) el.addEventListener('input', () => this.onSettingChanged());
    this.btnGenerate.addEventListener('click', handlers.onGenerate);
    this.btnCancel.addEventListener('click', () => {
      if (this.cancelling) return;
      this.cancelling = true;
      this.syncButtons();
      handlers.onCancel();
    });
    for (const el of [this.mpf, this.height]) {
      el.addEventListener('input', () => this.syncButtons());
    }
    this.renderBBox();
    this.syncButtons();
  }

  private onSettingChanged(): void {
    this.saveSettings();
    this.renderBBox();
    this.syncButtons();
  }

  private loadSettings(): void {
    try {
      const o = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
      const num = (k: string): number | null => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : null);
      const vs = num('voxelSize');
      if (vs !== null && vs >= VOXEL_MIN && vs <= VOXEL_MAX) this.voxelSize = vs;
      const t = num('tileSize');
      if (t !== null && t >= 50 && t <= 5000) this.tile.value = String(t);
      const w = num('workers');
      if (w !== null && Number.isInteger(w) && w >= 0 && w <= 16) this.workers.value = String(w);
      let m = num('maxVoxelsM');
      if (m !== null) {
        if (o.v !== 2 && m === 100) m = 50; // old default
        m = Math.max(1, Math.min(250, m));
        this.maxVox.value = String(m);
      }
    } catch {
      /* corrupt settings: keep defaults */
    }
    this.size.value = String(sizeToSlider(this.voxelSize));
    this.sizeNum.value = fmtSize(this.voxelSize);
  }

  private saveSettings(): void {
    const o: Record<string, number> = { v: 2, voxelSize: this.voxelSize };
    const t = parseDecimal(this.tile.value);
    if (t !== null && t >= 50 && t <= 5000) o.tileSize = t;
    const w = parseDecimal(this.workers.value);
    if (w !== null && Number.isInteger(w) && w >= 0 && w <= 16) o.workers = w;
    const m = parseDecimal(this.maxVox.value);
    if (m !== null && m >= 1 && m <= 250) o.maxVoxelsM = m;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(o));
  }

  /** Validate a decimal text input (accepts '.' or ','); returns the number or an error text. */
  private parseField(el: HTMLInputElement, label: string, min: number, max: number): { value: number } | { error: string } {
    const v = parseDecimal(el.value);
    if (v === null) return { error: `${label}: enter a number like 3.5 or 3,5` };
    if (v < min || v > max) return { error: `${label} must be between ${min} and ${max}` };
    return { value: v };
  }

  private paramsProblem(): string | null {
    const checks: Array<[HTMLInputElement, string, number, number]> = [
      [this.sizeNum, 'Voxel size', VOXEL_MIN, VOXEL_MAX],
      [this.tile, 'Tile size', 50, 5000],
      [this.workers, 'Workers', 0, 16],
      [this.maxVox, 'Max voxels (M)', 1, 250],
      [this.mpf, 'Metres / floor', 1, 10],
      [this.height, 'Default height', 1, 500],
    ];
    let first: string | null = null;
    for (const [el, label, min, max] of checks) {
      const r = this.parseField(el, label, min, max);
      el.classList.toggle('invalid', 'error' in r);
      if ('error' in r && !first) first = r.error;
      if (!('error' in r) && el === this.workers && !Number.isInteger(r.value)) {
        el.classList.add('invalid');
        first ??= 'Workers must be a whole number';
      }
    }
    return first;
  }

  setBBox(b: BBox | null): void {
    this.bbox = b;
    this.renderBBox();
    this.syncButtons();
  }

  private renderRamHint(): void {
    const m = this.validNum(this.maxVox, 1, 250);
    const el = this.maxVoxHint;
    if (m === null) {
      el.textContent = '';
      el.classList.remove('hint-warn');
      return;
    }
    const gb = (m * 1e6 * 35) / 1e9;
    el.textContent = m > 100 ? `needs several GB RAM (~${gb.toFixed(1)} GB)` : `\u2248${gb.toFixed(1)} GB RAM`;
    el.classList.toggle('hint-warn', m > 100);
  }

  private renderBBox(): void {
    this.renderRamHint();
    const b = this.bbox;
    this.warn.classList.remove('show', 'err');
    this.warn.textContent = '';
    this.tooBig = false;
    this.blocked = '';
    if (!b) {
      this.info.textContent = 'Draw a rectangle on the map.';
      return;
    }
    const tileSize = this.validNum(this.tile, 50, 5000) ?? 500;
    const maxVoxels = (this.validNum(this.maxVox, 1, 250) ?? DEFAULT_MAX_VOXELS / 1e6) * 1e6;
    const vs = this.voxelSize;
    const est = estimateBBox(b, vs, tileSize);
    this.info.innerHTML = '';
    const lines = [
      `N ${b.latMax.toFixed(5)}  S ${b.latMin.toFixed(5)}`,
      `W ${b.lonMin.toFixed(5)}  E ${b.lonMax.toFixed(5)}`,
      `~${(est.widthM / 1000).toFixed(2)} x ${(est.heightM / 1000).toFixed(2)} km (${est.areaKm2.toFixed(2)} km²)`,
      `up to ~${fmtCount(est.voxels)} voxels (approx.; ground layer ${fmtCount(est.groundVoxels)})`,
      `\u2248 ${est.tileCount.toLocaleString()} tile${est.tileCount === 1 ? '' : 's'} of ${fmtSize(tileSize)} m` +
        (est.tileCount > 1 ? ` (${est.tilesX} x ${est.tilesY})` : ''),
    ];
    for (const l of lines) {
      const d = document.createElement('div');
      d.textContent = l;
      this.info.appendChild(d);
    }
    const split = est.tileCount > 1 ? ` The run will be split into ${est.tileCount.toLocaleString()} tiles of ${fmtSize(tileSize)} m.` : '';
    if (est.maxAxisVoxels > INT32_AXIS_LIMIT || est.columns > INT32_FLAT_LIMIT) {
      const what = est.maxAxisVoxels > INT32_AXIS_LIMIT
        ? `${fmtCount(est.maxAxisVoxels)} voxels along one axis`
        : `${fmtCount(est.columns)} ground columns`;
      this.tooBig = true;
      this.blocked = `Voxel grid index would overflow int32 (${what}) \u2014 raise voxel size or shrink area`;
      this.warn.classList.add('show', 'err');
      this.warn.textContent = `Voxel grid index could exceed int32: ${what} (limit ~2B). Raise the voxel size or shrink the area.`;
    } else if (est.voxels > maxVoxels) {
      this.tooBig = true;
      this.blocked = `Estimate ~${fmtCount(est.voxels)} exceeds the ${fmtCount(maxVoxels)} voxel cap \u2014 reduce area, increase voxel size or raise Max voxels`;
      this.warn.classList.add('show', 'err');
      this.warn.textContent = `Estimate ~${fmtCount(est.voxels)} voxels exceeds the ${fmtCount(maxVoxels)} cap (tiling bounds memory per tile, not the total).${split} Shrink the area, raise the voxel size or raise Max voxels.`;
    } else if (est.voxels > maxVoxels * 0.4) {
      this.warn.classList.add('show');
      this.warn.textContent = `Large run (~${fmtCount(est.voxels)} voxels, near the ${fmtCount(maxVoxels)} cap): slow, and the preview may be heavy.${split}`;
    } else if (est.tileCount > 1) {
      this.warn.classList.add('show');
      this.warn.textContent = `This run will be split into ${est.tileCount.toLocaleString()} tiles of ${fmtSize(tileSize)} m.` +
        (est.tileCount > 50 ? ' Many tiles: expect a long run.' : '');
    }
  }

  private validNum(el: HTMLInputElement, min: number, max: number): number | null {
    const v = parseDecimal(el.value);
    return v !== null && v >= min && v <= max ? v : null;
  }

  /** Another job (building detail/analysis) owns the backend: block Generate with a reason. */
  setExternalBlock(reason: string): void {
    this.external = reason;
    this.syncButtons();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    if (!busy) this.cancelling = false;
    this.syncButtons();
  }

  private syncButtons(): void {
    const problem = this.paramsProblem();
    this.paramsError.textContent = problem ?? '';
    let reason = '';
    if (this.busy) reason = this.cancelling ? 'Cancelling, please wait...' : '';
    else if (this.external) reason = this.external;
    else if (!this.bbox) reason = 'Draw a rectangle on the map first';
    else if (this.tooBig) reason = this.blocked;
    else if (problem) reason = `Fix the invalid setting: ${problem}`;
    this.btnGenerate.disabled = this.busy || !!reason;
    this.btnGenerate.title = this.btnGenerate.disabled && reason ? reason : '';
    this.genRow.title = this.btnGenerate.title;
    this.reason.textContent = reason;
    this.reason.classList.toggle('attn', !!reason && !this.busy);
    this.btnCancel.disabled = !this.busy || this.cancelling;
    this.btnCancel.textContent = this.cancelling ? 'Cancelling…' : 'Cancel';
  }

  /** Returns null if inputs are invalid / no bbox. */
  readParams(): GenerateParams | null {
    if (!this.bbox) return null;
    if (this.paramsProblem() || this.tooBig) return null;
    const mpf = parseDecimal(this.mpf.value);
    const height = parseDecimal(this.height.value);
    if (mpf === null || height === null) return null;
    const token = this.token.value.trim();
    return {
      bbox: this.bbox,
      voxelSize: this.voxelSize,
      tileSize: parseDecimal(this.tile.value) ?? 500,
      workers: parseDecimal(this.workers.value) ?? 0,
      features: {
        roads: this.roads.checked,
        elevation: this.elevation.checked,
        proceduralFacades: this.facades.checked,
      },
      ...(token ? { mapillaryToken: token } : {}),
      metersPerFloor: mpf,
      defaultBuildingHeight: height,
      maxVoxels: Math.round((parseDecimal(this.maxVox.value) ?? 50) * 1e6),
    };
  }
}
