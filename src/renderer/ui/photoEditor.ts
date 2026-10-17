import type { PhotoQuad } from '../../shared/contract';
import { validateQuad, type Quad } from '../detail/homography';
import { h } from './h';

const MIN_LONG_SIDE = 300;
const MAX_H = 420;
const LABELS = ['TL', 'TR', 'BR', 'BL'] as const;

/** Photo with four draggable corner handles (TL,TR,BR,BL). Corners are in the pixel space of the displayed image. */
export class PhotoQuadEditor {
  readonly el: HTMLElement;
  readonly canvas = h('canvas', { class: 'pe-canvas' });
  img: HTMLImageElement | null = null;
  corners: [number, number][] = [];
  /** `final` is false while a handle is being dragged and true once the pointer is released (or on load). */
  onChange: (final: boolean) => void = () => {};
  private scale = 1;
  private radius = 9;
  private ro: ResizeObserver | null = null;
  private drag = -1;

  constructor() {
    this.el = h('div', { class: 'pe', hidden: true }, this.canvas);
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      const p = this.toImg(e);
      let best = -1, bd = Infinity;
      this.corners.forEach((q, i) => {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]) * this.scale;
        if (d < bd) { bd = d; best = i; }
      });
      if (bd <= this.radius * 2) { this.drag = best; c.setPointerCapture(e.pointerId); }
    });
    c.addEventListener('pointermove', (e) => {
      if (this.drag < 0 || !this.img) return;
      const p = this.toImg(e);
      this.corners[this.drag] = [Math.max(0, Math.min(this.img.naturalWidth, p[0])), Math.max(0, Math.min(this.img.naturalHeight, p[1]))];
      this.draw();
      this.onChange(false);
    });
    const end = (): void => {
      if (this.drag >= 0) { this.drag = -1; this.draw(); this.onChange(true); }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  async load(url: string): Promise<void> {
    const img = new Image();
    img.src = url;
    await img.decode();
    this.img = img;
    const w = img.naturalWidth, hh = img.naturalHeight;
    const m = Math.max(0.15, Math.min(0.3, 20 / Math.max(1, Math.min(w, hh)))); // inset, kept inside the image
    this.corners = [[w * m, hh * m], [w * (1 - m), hh * m], [w * (1 - m), hh * (1 - m)], [w * m, hh * (1 - m)]];
    this.el.hidden = false;
    this.layout();
    this.ro ??= new ResizeObserver(() => this.layout());
    this.ro.disconnect();
    this.ro.observe(this.el);
    this.onChange(true);
  }

  /** null when the quad is usable, else a user-facing reason. */
  validate(): string | null {
    if (!this.img) return 'Choose a photo first.';
    return validateQuad(this.corners as unknown as Quad, this.img.naturalWidth, this.img.naturalHeight);
  }

  dispose(): void {
    this.ro?.disconnect();
  }

  /** Call after the container becomes visible/resizes. */
  layout(): void {
    if (!this.img) return;
    const iw = this.img.naturalWidth, ih = this.img.naturalHeight;
    const maxW = Math.max(200, this.el.clientWidth || 300);
    let sc = Math.min(maxW / iw, MAX_H / ih);
    if (Math.max(iw, ih) * sc < MIN_LONG_SIDE) sc = MIN_LONG_SIDE / Math.max(iw, ih); // scale small photos up
    this.scale = sc;
    this.radius = Math.max(7, Math.min(14, Math.min(iw, ih) * sc * 0.035));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(this.img.naturalWidth * this.scale), ch = Math.round(this.img.naturalHeight * this.scale);
    this.canvas.width = cw * dpr;
    this.canvas.height = ch * dpr;
    this.canvas.style.width = `${cw}px`;
    this.canvas.style.height = `${ch}px`;
    this.draw();
  }

  getCorners(): PhotoQuad {
    return this.corners.map((c) => [Math.round(c[0] * 10) / 10, Math.round(c[1] * 10) / 10]) as PhotoQuad;
  }

  private toImg(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * (this.img?.naturalWidth ?? 1), ((e.clientY - r.top) / r.height) * (this.img?.naturalHeight ?? 1)];
  }

  private draw(): void {
    const img = this.img;
    if (!img) return;
    const g = this.canvas.getContext('2d')!;
    const k = this.canvas.width / img.naturalWidth;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
    const bad = this.validate() !== null;
    g.lineWidth = 2;
    g.strokeStyle = bad ? '#ff4d4d' : '#ffd23f';
    g.fillStyle = bad ? 'rgba(255,77,77,.15)' : 'rgba(255,210,63,.12)';
    g.beginPath();
    this.corners.forEach((c, i) => (i ? g.lineTo(c[0] * k, c[1] * k) : g.moveTo(c[0] * k, c[1] * k)));
    g.closePath();
    g.fill();
    g.stroke();
    const rr = this.radius * (this.canvas.width / (parseFloat(this.canvas.style.width) || this.canvas.width));
    g.font = `${Math.round(rr * 1.2)}px sans-serif`;
    this.corners.forEach((c, i) => {
      g.beginPath();
      g.arc(c[0] * k, c[1] * k, rr, 0, Math.PI * 2);
      g.fillStyle = '#ff5a1f';
      g.fill();
      g.strokeStyle = '#fff';
      g.stroke();
      g.fillStyle = '#fff';
      // keep the label inside the canvas: flip to the left/below of the handle near the right/top edges
      const tw = g.measureText(LABELS[i]!).width;
      let lx = c[0] * k + rr + 2, ly = c[1] * k - rr * 0.4;
      if (lx + tw > this.canvas.width - 2) lx = c[0] * k - rr - 2 - tw;
      if (ly < rr * 1.3) ly = c[1] * k + rr * 1.6;
      if (ly > this.canvas.height - 3) ly = c[1] * k - rr;
      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0,0,0,.7)';
      g.lineWidth = 3;
      g.strokeText(LABELS[i]!, lx, ly);
      g.fillText(LABELS[i]!, lx, ly);
    });
  }
}
