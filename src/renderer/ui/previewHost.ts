import type { BuildingInfo } from '../../shared/contract';
import type { HighlightSpec, PreviewHandle, SurfaceHit } from '../preview';
import { DegradeTracker, peekVoxelCount } from '../preview/budget';
export type { HighlightSpec, SurfaceHit };

type MountOpts = { voxels?: number; degrade?: number };
type PreviewModule = {
  mountPreview?: (container: HTMLElement, opts?: MountOpts) => PreviewHandle;
  mountPreviewAsync?: (container: HTMLElement, opts?: MountOpts) => Promise<PreviewHandle>;
};

/** Lazily mounts the Three.js preview (owned by another module); degrades gracefully if absent. */
export class PreviewHost {
  private handle: PreviewHandle | null = null;

  private ao = true;
  private aoLocked = true;
  /** Explicit user choice (checkbox / O key); survives dispose + remount. null = size-based default. */
  private userAo: boolean | null = null;

  /** Called whenever the effective AO state / availability changes. */
  onAoChange: (on: boolean, enabled: boolean) => void = () => {};

  /** Render-budget degradation, raised once per incident (context loss / failed creation), decays when stable. */
  private readonly degrade = new DegradeTracker();
  /** Bumped by dispose(): an in-flight load() that finds it changed was superseded and must not touch the host. */
  private epoch = 0;
  /** Forget the degradation: call when a NEW world is generated/opened (not on Reload or automatic remounts). */
  resetDegrade(): void { this.degrade.reset(); }
  get degradeLevel(): number { return this.degrade.level(); }
  /** Called when the WebGL context was lost and did not recover; the owner should reload the preview. */
  onContextLost: () => void = () => {};

  private pickCb: ((hit: SurfaceHit | null) => void) | null = null;
  private hl: HighlightSpec | null = null;
  private markers: readonly BuildingInfo[] | null = null;
  private markersVisible = true;
  private paused = false;

  /** Click-pick callback (survives remounts). */
  set onPick(cb: ((hit: SurfaceHit | null) => void) | null) {
    this.pickCb = cb;
    if (this.handle) this.handle.onPick = cb;
  }

  setHighlight(h: HighlightSpec | null): void {
    this.hl = h;
    this.handle?.setHighlight(h);
  }
  /** Saved-detail markers; remembered here so they survive the dispose + remount done on every (re)load. */
  setMarkers(list: readonly BuildingInfo[] | null): void {
    this.markers = list && list.length ? list : null;
    this.handle?.setMarkers(this.markers);
  }
  setMarkersVisible(v: boolean): void {
    this.markersVisible = v;
    this.handle?.setMarkersVisible(v);
  }
  focusBuilding(b: BuildingInfo): void { this.handle?.focusBuilding(b); }
  get voxelSize(): number { return this.handle?.getVoxelSize() ?? 0; }
  get inDetail(): boolean { return this.handle?.inDetail() ?? false; }
  showDetail(buf: ArrayBuffer): void { this.handle?.showDetail(buf); this.container.querySelector('canvas')?.focus({ preventScroll: true }); }
  backToCity(): void { this.handle?.backToCity(); this.container.querySelector('canvas')?.focus({ preventScroll: true }); }
  setCutaway(slabY: number | null): void { this.handle?.setCutaway(slabY); }
  /** Stop / resume the render loop (walking window open: the GPU belongs to it). Survives remounts. */
  setPaused(p: boolean): void {
    this.paused = p;
    this.handle?.setPaused(p);
  }
  /** City voxel [x, z] under the view, for "Walk here"; null when unknown (no city, or a detail scene is shown). */
  viewSpot(): { x: number; z: number } | null { return this.handle?.getViewSpot() ?? null; }
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
        if (!this.handle || this.paused || this.container.offsetParent === null) return;
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

  /** Resolves true when the scene is up, false when dispose() superseded this load (nothing was mounted). */
  async load(buf: ArrayBuffer): Promise<boolean> {
    const ep = this.epoch;
    if (!this.handle) {
      const mod = (await import('../preview')) as PreviewModule;
      if (ep !== this.epoch) return false;
      const opts: MountOpts = { voxels: peekVoxelCount(buf), degrade: this.degrade.level() };
      let h: PreviewHandle;
      try {
        if (typeof mod.mountPreviewAsync === 'function') h = await mod.mountPreviewAsync(this.container, opts);
        else if (typeof mod.mountPreview === 'function') h = mod.mountPreview(this.container, opts);
        else throw new Error('Preview module does not export mountPreview');
      } catch (e) {
        if (ep === this.epoch) this.degrade.bump(); // the next Reload asks for less
        throw e;
      }
      if (ep !== this.epoch) { // disposed (or superseded) while the context was being created: release it, bail quietly
        h.dispose();
        return false;
      }
      h.onContextLost = () => {
        if (this.handle !== h) return;
        this.degrade.bump();
        this.onContextLost();
      };
      this.handle = h;
    }
    this.handle.onPick = this.pickCb;
    this.handle.setPaused(this.paused);
    this.handle.load(buf);
    this.hl = null;
    this.handle.setMarkersVisible(this.markersVisible);
    this.handle.setMarkers(this.markers);
    let s = this.handle.getAmbientOcclusion();
    if (this.userAo !== null && s.available && s.on !== this.userAo) {
      this.handle.setAmbientOcclusion(this.userAo);
      s = this.handle.getAmbientOcclusion();
    }
    this.ao = s.on;
    this.aoLocked = !s.available;
    this.onAoChange(this.ao, !this.aoLocked);
    this.container.querySelector('canvas')?.focus({ preventScroll: true });
    return true;
  }

  dispose(): void {
    this.epoch++;
    this.handle?.dispose();
    this.handle = null;
    this.aoLocked = true;
    this.hl = null;
    this.onAoChange(this.ao, false);
  }
}
