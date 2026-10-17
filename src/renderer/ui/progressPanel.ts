import type { GenerateStats, Stage } from '../../shared/contract';
import { $ } from './dom';

const STALL_MS = 2500;

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class ProgressPanel {
  private bar = $('progress-bar');
  private barWrap = $('progress-barwrap');
  private state = $('progress-state');
  private elapsed = $('progress-elapsed');
  private text = $('progress-text');
  private stats = $('stats');
  private timer: number | null = null;
  private t0 = 0;
  private lastPct = -1;
  private lastTile = -1;
  private lastChange = 0;
  private cancelling = false;

  /** Called when Generate is clicked: starts the renderer-clock elapsed counter. */
  reset(): void {
    this.stop();
    this.cancelling = false;
    this.stats.textContent = '';
    this.text.classList.remove('err');
    this.text.removeAttribute('title');
    this.barWrap.classList.remove('failed', 'indet');
    this.state.textContent = 'Running';
    this.state.classList.remove('tile-state');
    this.t0 = this.lastChange = performance.now();
    this.lastPct = -1;
    this.set(0, 'Starting...');
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 250);
  }

  private tick(): void {
    const now = performance.now();
    this.elapsed.textContent = `Elapsed ${fmtElapsed(now - this.t0)}`;
    // No pct change for a while (e.g. a long Overpass call): show an activity animation.
    this.barWrap.classList.toggle('indet', now - this.lastChange > STALL_MS);
  }

  private stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.barWrap.classList.remove('indet');
  }

  update(e: { stage: Stage; pct: number; message: string; tile?: { done: number; total: number } }): void {
    if (this.timer === null || this.cancelling) return; // late event after settle / cancel
    const tileKey = e.tile ? e.tile.done : -1;
    if (e.pct !== this.lastPct || tileKey !== this.lastTile) {
      this.lastPct = e.pct;
      this.lastTile = tileKey;
      this.lastChange = performance.now();
    }
    this.set(e.pct, `${e.stage}: ${e.message}`);
    if (e.tile && e.tile.total > 0) {
      this.state.textContent = `Tile ${e.tile.done} of ${e.tile.total}`;
      this.state.classList.add('tile-state');
    } else {
      this.state.textContent = 'Running';
      this.state.classList.remove('tile-state');
    }
    this.tick();
  }

  setCancelling(): void {
    this.cancelling = true;
    this.state.textContent = 'Cancelling…';
    this.text.classList.remove('err');
    this.text.textContent = 'Cancelling…';
    this.barWrap.classList.add('indet');
  }

  private set(pct: number, msg: string): void {
    this.text.removeAttribute('title');
    this.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    this.text.textContent = msg;
  }

  done(label: string): void {
    this.finish(100, label, 'Done');
  }

  private finish(pct: number, msg: string, state: string): void {
    if (this.timer !== null) this.tick();
    this.stop();
    this.cancelling = false;
    this.state.textContent = state;
    this.state.classList.remove('tile-state');
    this.set(pct, msg);
  }

  cancelled(): void {
    this.barWrap.classList.remove('failed');
    this.finish(0, 'Cancelled.', 'Cancelled');
  }

  /** Show code + message directly in the progress area. */
  fail(code: string, message: string): void {
    this.barWrap.classList.add('failed');
    this.finish(0, message, 'Failed');
    const full = code ? `${code}: ${message}` : message;
    const trimmed = message.trim();
    const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(trimmed);
    let first = (m ? m[0] : trimmed.split('\n')[0]).trim();
    if (first.length > 120) first = `${first.slice(0, 117)}...`;
    this.text.classList.add('err');
    this.text.title = full;
    this.text.textContent = '';
    const head = document.createElement('div');
    head.className = 'err-head';
    head.textContent = code ? `${code}: ${first.replace(/[.]$/, '')}` : first;
    this.text.appendChild(head);
    const rest = first.endsWith('...') ? trimmed : trimmed.slice(m ? m[0].length : first.length).trim();
    if (rest) {
      const body = document.createElement('div');
      body.className = 'err-body';
      body.textContent = rest;
      this.text.appendChild(body);
    }
    this.text.scrollTop = 0;
  }

  showStats(s: GenerateStats): void {
    this.stats.textContent =
      `${s.voxelCount.toLocaleString()} voxels, ${s.buildingCount} buildings ` +
      `(${s.buildingsWithPhotos} photo, ${s.buildingsProcedural} procedural), ${(s.elapsedMs / 1000).toFixed(1)} s`;
  }
}
