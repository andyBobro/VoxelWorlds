import type { FacadeRect, FacadeSpec, PhotoQuad } from '../../shared/contract';
import { rectify, validateQuad, type Quad } from '../detail/homography';
import {
  LOW_CONFIDENCE, wallSizeError, addRect, finalizeSpec, hexToRgb, moveFloorLine, moveRect, removeRect, resizeRect, resizeWall,
  rgbToHex, setFloors, updateRect, type Handle,
} from '../detail/spec';
import { h, field, num } from './h';

type Kind = 'windows' | 'doors';
interface Sel { kind: Kind; i: number; }
type Drag =
  | { t: 'move'; sel: Sel; u: number; v: number; orig: FacadeRect }
  | { t: 'resize'; sel: Sel; handle: Handle; u: number; v: number; orig: FacadeRect }
  | { t: 'line'; i: number };

const HANDLES: Array<[Handle, number, number]> = [
  ['nw', 0, 1], ['n', 0.5, 1], ['ne', 1, 1], ['e', 1, 0.5], ['se', 1, 0], ['s', 0.5, 0], ['sw', 0, 0], ['w', 0, 0.5],
];
const RES = 300; // rectified warp resolution (px)

/** Rectified preview of the wall (warped client-side from the photo) with an editable FacadeSpec overlay. */
export class FacadeEditor {
  readonly el: HTMLElement;
  spec: FacadeSpec | null = null;
  onChange: () => void = () => {};
  private readonly canvas = h('canvas', { class: 'fe-canvas' });
  private readonly floorsIn = num(1, 'Floors');
  private readonly wallC = h('input', { type: 'color' });
  private readonly trimC = h('input', { type: 'color' });
  private readonly glassC = h('input', { type: 'color' });
  private readonly material = h('select');
  private readonly info = h('div', { class: 'muted' });
  private readonly delBtn = h('button', { text: 'Delete', title: 'Delete selected (Del)', disabled: true });
  dispose(): void {
    this.ro?.disconnect();
  }

  private rectified: HTMLCanvasElement | null = null;
  private sel: Sel | null = null;
  private drag: Drag | null = null;
  private H = 100;
  private cw = 300;
  private ro: ResizeObserver | null = null;

  constructor() {
    for (const m of ['plaster', 'brick', 'stone', 'concrete', 'glass', 'wood', 'metal']) this.material.append(h('option', { text: m, value: m }));
    const addW = h('button', { text: '+ Window' });
    const addD = h('button', { text: '+ Door' });
    addW.addEventListener('click', () => this.edit((s) => addRect(s, 'windows'), { kind: 'windows', i: -1 }));
    addD.addEventListener('click', () => this.edit((s) => addRect(s, 'doors'), { kind: 'doors', i: -1 }));
    this.delBtn.addEventListener('click', () => this.deleteSelected());
    this.floorsIn.addEventListener('change', () => this.edit((s) => setFloors(s, Number(this.floorsIn.value))));
    const colour = (inp: HTMLInputElement, key: 'wallColour' | 'trimColour' | 'glassColour'): void =>
      inp.addEventListener('input', () => this.edit((s) => ({ ...s, [key]: hexToRgb(inp.value) })));
    colour(this.wallC, 'wallColour');
    colour(this.trimC, 'trimColour');
    colour(this.glassC, 'glassColour');
    this.material.addEventListener('change', () => this.edit((s) => ({ ...s, material: this.material.value as FacadeSpec['material'] })));

    this.el = h('div', { class: 'fe', hidden: true },
      this.canvas,
      this.info,
      h('div', { class: 'row buttons' }, addW, addD, this.delBtn),
      h('div', { class: 'row' }, field('Floors', this.floorsIn), field('Material', this.material)),
      h('div', { class: 'row colours' }, field('Wall', this.wallC), field('Trim', this.trimC), field('Glass', this.glassC)),
    );
    this.ro = new ResizeObserver(() => {
      if (this.spec && !this.el.hidden && Math.round(this.el.clientWidth) !== this.cw) this.layout();
    });
    this.ro.observe(this.el);
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelected(); }
    });
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    const up = (): void => { this.drag = null; };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
  }

  setSpec(spec: FacadeSpec): void {
    this.spec = spec;
    this.sel = null;
    this.el.hidden = false;
    this.refreshControls();
    this.layout();
  }

  getSpec(): FacadeSpec | null {
    return this.spec ? finalizeSpec(this.spec) : null;
  }

  setWallSize(w: number, hh: number): void {
    if (!this.spec || wallSizeError(w, hh)) return; // keep the last valid overlay for out-of-range sizes
    this.spec = resizeWall(this.spec, w, hh);
    this.layout();
  }

  /** Re-warp the photo through the quad (when corners/size change). Silently shows the grid if the image is tainted. */
  setPhoto(img: HTMLImageElement, corners: PhotoQuad, lowRes = false): void {
    this.rectified = null;
    const q = corners as unknown as Quad;
    if (validateQuad(q, img.naturalWidth, img.naturalHeight) !== null || !this.spec) { this.draw(); return; }
    try {
      const s = Math.min(1, (lowRes ? 400 : 1400) / Math.max(img.naturalWidth, img.naturalHeight));
      const sw = Math.max(1, Math.round(img.naturalWidth * s)), sh = Math.max(1, Math.round(img.naturalHeight * s));
      const off = document.createElement('canvas');
      off.width = sw; off.height = sh;
      const g = off.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0, sw, sh);
      const src = g.getImageData(0, 0, sw, sh);
      const ow = lowRes ? RES : RES * 2, oh = Math.max(40, Math.round((ow * this.spec.wallHeightM) / this.spec.wallWidthM));
      const out = new ImageData(ow, oh);
      const scaled = q.map((p) => [p[0] * s, p[1] * s] as const) as unknown as Quad;
      rectify(src.data, sw, sh, scaled, out.data, ow, oh);
      const rc = document.createElement('canvas');
      rc.width = ow; rc.height = oh;
      rc.getContext('2d')!.putImageData(out, 0, 0);
      this.rectified = rc;
    } catch {
      this.rectified = null;
    }
    this.draw();
  }

  private layout(): void {
    if (!this.spec) return;
    this.cw = Math.max(200, Math.round(this.el.clientWidth || 300));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.H = Math.round(Math.max(60, Math.min(420, (this.cw * this.spec.wallHeightM) / this.spec.wallWidthM)));
    this.canvas.width = this.cw * dpr;
    this.canvas.height = this.H * dpr;
    this.canvas.style.width = `${this.cw}px`;
    this.canvas.style.height = `${this.H}px`;
    this.draw();
  }

  private refreshControls(): void {
    const s = this.spec;
    if (!s) return;
    this.floorsIn.value = String(s.floors);
    this.wallC.value = rgbToHex(s.wallColour);
    this.trimC.value = rgbToHex(s.trimColour);
    this.glassC.value = rgbToHex(s.glassColour);
    this.material.value = s.material;
    this.delBtn.disabled = !this.sel;
    const c = s.confidence;
    const low = (['floors', 'windows', 'doors', 'colour'] as const).filter((k) => c[k] < LOW_CONFIDENCE);
    this.info.textContent =
      `${s.windows.length} windows, ${s.doors.length} doors, ${s.floors} floors | confidence F${c.floors.toFixed(2)} W${c.windows.toFixed(2)} D${c.doors.toFixed(2)} C${c.colour.toFixed(2)}` +
      (low.length ? ` | low: ${low.join(', ')} (red, please check)` : '');
    this.info.className = low.length ? 'warn' : 'muted';
  }

  private edit(fn: (s: FacadeSpec) => FacadeSpec, select?: Sel): void {
    if (!this.spec) return;
    this.spec = fn(this.spec);
    if (select) this.sel = { kind: select.kind, i: this.spec[select.kind].length - 1 };
    this.refreshControls();
    this.draw();
    this.onChange();
  }

  private deleteSelected(): void {
    const s = this.sel;
    if (!s) return;
    this.sel = null;
    this.edit((sp) => removeRect(sp, s.kind, s.i));
  }

  // metres <-> canvas css px
  private px(u: number, v: number): [number, number] {
    const s = this.spec!;
    return [(u / s.wallWidthM) * this.cw, this.H - (v / s.wallHeightM) * this.H];
  }
  private metres(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect(), s = this.spec!;
    return [((e.clientX - r.left) / r.width) * s.wallWidthM, (1 - (e.clientY - r.top) / r.height) * s.wallHeightM];
  }

  private hit(u: number, v: number): { sel: Sel; handle?: Handle } | { line: number } | null {
    const s = this.spec!;
    const tol = (8 / this.cw) * s.wallWidthM;
    if (this.sel) {
      const r = s[this.sel.kind][this.sel.i];
      if (r) for (const [hd, fx, fy] of HANDLES) {
        if (Math.abs(u - (r.u + fx * r.w)) < tol && Math.abs(v - (r.v + fy * r.h)) < tol) return { sel: this.sel, handle: hd };
      }
    }
    for (const kind of ['doors', 'windows'] as const) {
      for (let i = s[kind].length - 1; i >= 0; i--) {
        const r = s[kind][i]!;
        if (u >= r.u && u <= r.u + r.w && v >= r.v && v <= r.v + r.h) return { sel: { kind, i } };
      }
    }
    const lt = (6 / this.H) * s.wallHeightM;
    for (let i = 0; i < s.floorLinesV.length; i++) if (Math.abs(v - s.floorLinesV[i]!) < lt) return { line: i };
    return null;
  }

  private down(e: PointerEvent): void {
    if (!this.spec) return;
    this.canvas.focus({ preventScroll: true });
    const [u, v] = this.metres(e);
    const hit = this.hit(u, v);
    if (!hit) { this.sel = null; this.refreshControls(); this.draw(); return; }
    this.canvas.setPointerCapture(e.pointerId);
    if ('line' in hit) { this.drag = { t: 'line', i: hit.line }; return; }
    this.sel = hit.sel;
    const orig = this.spec[hit.sel.kind][hit.sel.i]!;
    this.drag = hit.handle ? { t: 'resize', sel: hit.sel, handle: hit.handle, u, v, orig } : { t: 'move', sel: hit.sel, u, v, orig };
    this.refreshControls();
    this.draw();
  }

  private move(e: PointerEvent): void {
    const d = this.drag, s = this.spec;
    if (!d || !s) return;
    const [u, v] = this.metres(e);
    if (d.t === 'line') {
      this.spec = moveFloorLine(s, d.i, v);
    } else {
      const du = u - d.u, dv = v - d.v;
      const r = d.t === 'move' ? moveRect(d.orig, du, dv, s.wallWidthM, s.wallHeightM) : resizeRect(d.orig, d.handle, du, dv, s.wallWidthM, s.wallHeightM);
      this.spec = updateRect(s, d.sel.kind, d.sel.i, r);
    }
    this.draw();
    this.onChange();
  }

  private draw(): void {
    const s = this.spec;
    if (!s) return;
    const g = this.canvas.getContext('2d')!;
    const k = this.canvas.width / this.cw;
    g.setTransform(k, 0, 0, k, 0, 0);
    if (this.rectified) g.drawImage(this.rectified, 0, 0, this.cw, this.H);
    else {
      g.fillStyle = rgbToHex(s.wallColour);
      g.fillRect(0, 0, this.cw, this.H);
    }
    const lowF = s.confidence.floors < LOW_CONFIDENCE, lowW = s.confidence.windows < LOW_CONFIDENCE, lowD = s.confidence.doors < LOW_CONFIDENCE;
    g.setLineDash([6, 4]);
    g.lineWidth = lowF ? 2.5 : 1.5;
    g.strokeStyle = lowF ? '#ff4d4d' : '#4fc3f7';
    for (const fv of s.floorLinesV) {
      const [, y] = this.px(0, fv);
      g.beginPath(); g.moveTo(0, y); g.lineTo(this.cw, y); g.stroke();
    }
    g.setLineDash([]);
    const rect = (r: FacadeRect, col: string, low: boolean, selected: boolean): void => {
      const [x0, y0] = this.px(r.u, r.v + r.h), [x1, y1] = this.px(r.u + r.w, r.v);
      g.fillStyle = col + '40';
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.lineWidth = selected ? 3 : low ? 2.5 : 1.5;
      g.strokeStyle = low ? '#ff4d4d' : col;
      if (low) g.setLineDash([4, 3]);
      g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.setLineDash([]);
    };
    s.windows.forEach((r, i) => rect(r, '#29d3ff', lowW, this.sel?.kind === 'windows' && this.sel.i === i));
    s.doors.forEach((r, i) => rect(r, '#ffa51f', lowD, this.sel?.kind === 'doors' && this.sel.i === i));
    if (this.sel) {
      const r = s[this.sel.kind][this.sel.i];
      if (r) {
        g.fillStyle = '#fff';
        g.strokeStyle = '#000';
        g.lineWidth = 1;
        for (const [, fx, fy] of HANDLES) {
          const [x, y] = this.px(r.u + fx * r.w, r.v + fy * r.h);
          g.fillRect(x - 4, y - 4, 8, 8);
          g.strokeRect(x - 4, y - 4, 8, 8);
        }
      }
    }
    this.delBtn.disabled = !this.sel;
  }
}
