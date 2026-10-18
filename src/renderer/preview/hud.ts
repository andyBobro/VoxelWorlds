import type { CameraMode } from './camera';

const BASE = 'position:absolute;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#fff;' +
  'background:rgba(0,0,0,.55);padding:6px 9px;border-radius:5px;pointer-events:none;user-select:none;z-index:5;';

/** HUD line shown when meshing stopped at the shared GPU geometry budget. */
export function hudTruncationNote(detail: boolean): string {
  return detail
    ? '\nGPU budget reached (city + detail): parts of this detail are not shown'
    : '\nGPU budget reached: outer area not shown (use a larger voxel size)';
}

export class Hud {
  private readonly stats = document.createElement('div');
  private readonly hint = document.createElement('div');
  private readonly button = document.createElement('button');
  private readonly root = document.createElement('div');

  constructor(container: HTMLElement, onToggle: () => void) {
    this.root.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    this.stats.style.cssText = BASE + 'left:8px;top:8px;white-space:pre;';
    this.hint.style.cssText = BASE + 'left:8px;bottom:8px;white-space:pre-wrap;';
    this.hint.className = 'hud-hint';
    this.button.style.cssText =
      BASE + 'right:8px;top:8px;pointer-events:auto;cursor:pointer;border:1px solid rgba(255,255,255,.35);';
    this.button.type = 'button';
    this.button.tabIndex = -1;
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggle();
      this.button.blur();
    });
    this.root.append(this.stats, this.hint, this.button);
    container.appendChild(this.root);
  }

  setMode(mode: CameraMode, locked: boolean, lockFailed = false): void {
    this.button.textContent = mode === 'orbit' ? 'Orbit (Tab: fly)' : 'Fly (Tab: orbit)';
    this.hint.textContent =
      mode === 'orbit'
        ? 'Orbit: left-drag rotate | right-drag pan | wheel zoom | Tab fly mode'
        : locked
          ? 'WASD move | Q/E down/up | Shift boost | wheel speed | Esc release | Tab orbit'
          : lockFailed
            ? 'Mouse capture unavailable - drag to look\nWASD move | Q/E down/up | Shift boost | wheel speed | Tab orbit'
            : 'Click view to capture mouse\nWASD move | Q/E down/up | Shift boost | wheel speed | Tab orbit';
  }

  setStats(s: { fps: number; voxels: number; triangles: number; calls: number; built: number; total: number; speed: number; mode: CameraMode; ao?: boolean; aoToggle?: boolean; truncated?: boolean; inDetail?: boolean; geoMB?: number }): void {
    const loading = s.built < s.total ? `  meshing ${s.built}/${s.total}` : '';
    this.stats.textContent =
      `${s.fps.toFixed(0)} FPS  draws ${s.calls}\n` +
      `voxels ${s.voxels.toLocaleString()}  tris ${s.triangles.toLocaleString()}${loading}${s.geoMB === undefined ? '' : `  geo ~${s.geoMB.toFixed(0)} MB`}` +
      (s.ao === undefined ? '' : `\nAO ${s.ao ? 'on' : 'off'}${s.aoToggle === false ? '' : ' (O to toggle)'}`) +
      (s.truncated ? hudTruncationNote(!!s.inDetail) : '') +
      (s.mode === 'fly' ? `\nspeed ${s.speed.toFixed(1)} m/s` : '');
  }

  dispose(): void {
    this.root.remove();
  }
}
