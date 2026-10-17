import type { HighlightSpec, PreviewHandle, SurfaceHit } from '../preview';
export type { HighlightSpec, SurfaceHit };

type PreviewModule = { mountPreview?: (container: HTMLElement) => PreviewHandle };

/** Lazily mounts the Three.js preview (owned by another module); degrades gracefully if absent. */
export class PreviewHost {
  private handle: PreviewHandle | null = null;

  private ao = true;
  private aoLocked = true;
  /** Explicit user choice (checkbox / O key); survives dispose + remount. null = size-based default. */
  private userAo: boolean | null = null;

  /** Called whenever the effective AO state / availability changes. */
  onAoChange: (on: boolean, enabled: boolean) => void = () => {};

  private pickCb: ((hit: SurfaceHit | null) => void) | null = null;
  private hl: HighlightSpec | null = null;

  /** Click-pick callback (survives remounts). */
  set onPick(cb: ((hit: SurfaceHit | null) => void) | null) {
    this.pickCb = cb;
    if (this.handle) this.handle.onPick = cb;
  }

  setHighlight(h: HighlightSpec | null): void {
    this.hl = h;
    this.handle?.setHighlight(h);
  }
  get voxelSize(): number { return this.handle?.getVoxelSize() ?? 0; }
  get inDetail(): boolean { return this.handle?.inDetail() ?? false; }
  showDetail(buf: ArrayBuffer): void { this.handle?.showDetail(buf); this.container.querySelector('canvas')?.focus({ preventScroll: true }); }
  backToCity(): void { this.handle?.backToCity(); this.container.querySelector('canvas')?.focus({ preventScroll: true }); }
  setCutaway(slabY: number | null): void { this.handle?.setCutaway(slabY); }
  setCameraMode(m: 'orbit' | 'fly'): void { this.handle?.setCameraMode(m); }

  constructor(private container: HTMLElement) {
    // 'O' works whenever the Preview tab is visible (capture phase, before the preview's own canvas handler).
    document.addEventListener(
      'keydown',
      (e) => {
        if ((e.key !== 'o' && e.key !== 'O') || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        const t = e.target as HTMLElement | null;
        if (
          t &&
          (t.isContentEditable ||
            /^(TEXTAREA|SELECT)$/.test(t.tagName) ||
            (t.tagName === 'INPUT' && !/^(checkbox|radio|button)$/.test((t as HTMLInputElement).type)))
        )
          return;
        if (!this.handle || this.container.offsetParent === null) return;
        e.stopPropagation();
        e.preventDefault();
        this.setAmbientOcclusion(!this.ao);
      },
      true,
    );
  }

  setAmbientOcclusion(on: boolean): void {
    if (!this.handle || this.aoLocked) return;
    this.userAo = on;
    this.ao = this.handle.setAmbientOcclusion(on);
    this.onAoChange(this.ao, !this.aoLocked);
  }

  async load(buf: ArrayBuffer): Promise<void> {
    if (!this.handle) {
      const mod = (await import('../preview')) as PreviewModule;
      if (typeof mod.mountPreview !== 'function') throw new Error('Preview module does not export mountPreview');
      this.handle = mod.mountPreview(this.container);
    }
    this.handle.onPick = this.pickCb;
    this.handle.load(buf);
    this.hl = null;
    let s = this.handle.getAmbientOcclusion();
    if (this.userAo !== null && s.available && s.on !== this.userAo) {
      this.handle.setAmbientOcclusion(this.userAo);
      s = this.handle.getAmbientOcclusion();
    }
    this.ao = s.on;
    this.aoLocked = !s.available;
    this.onAoChange(this.ao, !this.aoLocked);
    this.container.querySelector('canvas')?.focus({ preventScroll: true });
  }

  dispose(): void {
    this.handle?.dispose();
    this.handle = null;
    this.aoLocked = true;
    this.hl = null;
    this.onAoChange(this.ao, false);
  }
}
