import type { DetailRecord, WorldMeta } from '../../shared/contract';
import { detailRows, filterWorlds, fmtDate, fmtBytesTotal, libraryTooBig, sortWorldsBy, worldRow, type WorldSort } from '../lib/worlds';
import { h } from './h';
import { confirmBox } from './modal';
import { toast } from './toast';
import { errorText, stripCode } from './dom';
import type { WorldSession } from './worldSession';

export interface WorldsHooks {
  openWorld(meta: WorldMeta): Promise<void>;
  loadParams(meta: WorldMeta): void;
  openDetail(rec: DetailRecord): Promise<void>;
  /** opens the walking window for this saved world */
  walk(meta: WorldMeta): Promise<void>;
  /** a world was deleted from disk (main decides what to do when it is the one on screen) */
  onWorldDeleted(meta: WorldMeta): void;
  /** non-empty = actions that change the backend state are disabled with this reason */
  busyReason(): string;
  /** friendly name of a Geofabrik region id (falls back to the id) */
  regionName?(regionId: string): string;
}

/** "Worlds" tab: saved worlds library (open / rename / delete / load parameters) + all saved details of the current world. */
export class WorldsPanel {
  private renaming: { id: string; error: string } | null = null;
  private openState = new Map<string, boolean>();
  private busyId: string | null = null;
  private readonly list = h('div', { class: 'wl-list', id: 'worlds-list' });
  private readonly count = h('span', { class: 'muted', id: 'worlds-count' });
  private query = '';
  private sort: WorldSort = 'newest';
  private readonly err = h('div', { class: 'warn err', hidden: true });
  private readonly big = h('div', { class: 'warn', id: 'worlds-big', hidden: true, text: 'Library is large: delete worlds or details you no longer need.' });

  constructor(private readonly root: HTMLElement, private readonly session: WorldSession, private readonly hooks: WorldsHooks) {
    const refresh = h('button', { text: 'Rescan', class: 'wl-refresh', type: 'button', title: 'Rescan the worlds folder on disk' });
    refresh.addEventListener('click', () => void session.refreshWorlds());
    const search = h('input', { type: 'text', placeholder: 'Search worlds...', id: 'worlds-search' });
    search.setAttribute('aria-label', 'Search worlds');
    search.addEventListener('input', () => { this.query = search.value; this.render(); });
    const sort = h('select', { id: 'worlds-sort' });
    sort.setAttribute('aria-label', 'Sort worlds');
    for (const [v, t] of [['newest', 'Newest first'], ['name', 'Name'], ['size', 'Largest first']] as const) sort.append(h('option', { value: v, text: t }));
    sort.addEventListener('change', () => { this.sort = sort.value as WorldSort; this.render(); });
    root.append(
      h('div', { class: 'wl-head' }, h('h2', { text: 'Saved worlds' }), this.count, refresh),
      h('div', { class: 'wl-tools' }, search, sort),
      h('div', { class: 'muted wl-intro', text: 'Every generated world is saved automatically, together with its building details (interiors, photo facades).' }),
      this.err, this.big, this.list,
    );
    session.onChange(() => this.render());
    this.render();
  }

  /** Called by main when background busy state changed (disables Open/Delete). */
  refreshBusy(): void { this.render(); }

  private render(): void {
    const s = this.session;
    const busy = this.hooks.busyReason();
    this.count.textContent = s.worlds.length ? `${s.worlds.length} world${s.worlds.length === 1 ? '' : 's'} · ${fmtBytesTotal(s.worlds)} total` : '';
    this.big.hidden = !libraryTooBig(s.worlds);
    this.err.hidden = !s.loadError;
    this.err.textContent = s.loadError ? `Could not read the worlds library: ${s.loadError}` : '';
    this.list.replaceChildren();
    if (!s.worlds.length) {
      this.list.append(h('div', { class: 'wl-empty', id: 'worlds-empty' },
        h('b', { text: 'No saved worlds yet.' }),
        h('div', { class: 'muted', text: 'Draw an area on the Map tab and press Generate. The world will appear here and can be reopened any time, also after restarting the app.' })));
      return;
    }
    const shown = sortWorldsBy(filterWorlds(s.worlds, this.query), this.sort);
    if (!shown.length) this.list.append(h('div', { class: 'muted wl-empty-q', text: `No world matches "${this.query.trim()}".` }));
    for (const w of shown) this.list.append(this.card(w, busy));
  }

  private card(w: WorldMeta, busy: string): HTMLElement {
    const s = this.session;
    const row = worldRow(w);
    const isCur = s.currentId === w.id;
    const loading = this.busyId === w.id;

    // title / rename
    const title = h('div', { class: 'wl-title' });
    if (this.renaming?.id === w.id) {
      const inp = h('input', { type: 'text', value: w.name });
      inp.setAttribute('aria-label', 'World name');
      inp.maxLength = 120;
      const ok = h('button', { text: 'Save', class: 'primary', type: 'button' });
      const cancel = h('button', { text: 'Cancel', type: 'button' });
      const commit = async (): Promise<void> => {
        const name = inp.value.trim();
        if (!name) { this.renaming = { id: w.id, error: 'Name must not be empty.' }; this.render(); return; }
        if (name === w.name) { this.renaming = null; this.render(); return; }
        ok.disabled = true;
        try {
          const m = await window.voxel.renameWorld(w.id, name);
          s.worlds = s.worlds.map((x) => (x.id === m.id ? m : x));
          this.renaming = null;
          this.render();
          toast('World renamed');
        } catch (e) {
          this.renaming = { id: w.id, error: errorText(e).replace(/^[A-Z_]+:\s*/, '') };
          this.render();
        }
      };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); void commit(); }
        else if (e.key === 'Escape') { e.stopPropagation(); this.renaming = null; this.render(); }
      });
      ok.addEventListener('click', () => void commit());
      cancel.addEventListener('click', () => { this.renaming = null; this.render(); });
      title.append(inp, ok, cancel);
      queueMicrotask(() => { inp.focus(); inp.select(); });
    } else {
      title.append(h('b', { class: 'wl-name', text: row.name }));
      if (isCur) title.append(h('span', { class: 'badge sel', text: 'Current' }));
      const ds = w.params?.dataSource;
      title.append(h('span', { class: 'badge src', text: ds && ds.kind === 'pbf' ? `Geofabrik: ${this.hooks.regionName?.(ds.regionId) ?? ds.regionId}` : 'Overpass' }));
    }

    const stat = (k: string, v: string): HTMLElement => h('span', { class: 'wl-stat' }, h('span', { class: 'muted', text: `${k} ` }), h('b', { text: v }));
    const stats = h('div', { class: 'wl-stats' },
      stat('Voxels', row.voxels), stat('Buildings', row.buildings), stat('Details', String(row.details)), stat('Size', row.size));

    const open = h('button', { class: 'primary wl-open', text: loading ? 'Opening...' : isCur ? 'Reopen' : 'Open', type: 'button', disabled: !!busy || loading });
    const noVox = !(w.stats?.voxelCount > 0);
    const walkBtn = h('button', { text: 'Walk', class: 'wl-walk', type: 'button', disabled: !!busy || loading || noVox });
    walkBtn.title = busy || (noVox ? 'This world has no voxels to walk on' : 'Walk through this world in a new window');
    walkBtn.addEventListener('click', () => void this.hooks.walk(w));
    const load = h('button', { text: 'Load parameters', type: 'button', title: 'Fill the Generate form with this world’s settings' });
    const ren = h('button', { text: 'Rename', type: 'button' });
    const del = h('button', { text: 'Delete', class: 'danger', type: 'button', disabled: !!busy || loading });
    if (busy) { open.title = busy; del.title = busy; }
    open.addEventListener('click', () => void this.open(w));
    load.addEventListener('click', () => { this.hooks.loadParams(w); toast('Generate form filled from this world'); });
    ren.addEventListener('click', () => { this.renaming = { id: w.id, error: '' }; this.render(); });
    del.addEventListener('click', () => void this.remove(w));

    const card = h('div', { class: `wl-card ${isCur ? 'cur' : ''}` },
      title,
      this.renaming?.id === w.id && this.renaming.error ? h('div', { class: 'field-error wl-err', text: this.renaming.error }) : null,
      h('div', { class: 'muted wl-meta', text: `${row.date} · centre ${row.centre} · voxel ${row.voxelSize}${w.sourceInfo ? ` · Extract from ${w.sourceInfo.sourceDate ? fmtDate(w.sourceInfo.sourceDate).slice(0, 10) : 'unknown date'}` : ''}` }),
      stats,
      h('div', { class: 'row buttons wl-actions' }, open, walkBtn, load, ren, del),
    );
    card.dataset.world = w.id;
    if ((isCur ? this.session.details : w.details ?? []).length > 0) card.append(this.detailsBlock(w, isCur, busy));
    return card;
  }

  private detailsBlock(w: WorldMeta, isCur: boolean, busy: string): HTMLElement {
    const recs = isCur ? this.session.details : Array.isArray(w.details) ? w.details : [];
    const rows = detailRows(recs);
    const det = h('details', { class: 'wl-details', open: this.openState.get(w.id) ?? isCur }, h('summary', { text: `Saved details (${rows.length})` }));
    det.addEventListener('toggle', () => { this.openState.set(w.id, det.open); });
    if (!rows.length) det.append(h('div', { class: 'muted', text: 'No details yet. Pick a building in the 3D Preview and generate a detail; it is saved here.' }));
    for (const r of rows) {
      const rec = recs.find((d) => d.id === r.id)!;
      const open = h('button', { text: 'Open', class: 'primary', type: 'button', disabled: !!busy });
      if (busy) open.title = busy;
      open.addEventListener('click', () => void this.hooks.openDetail(rec));
      const del = h('button', { text: 'Delete', class: 'danger', type: 'button', disabled: !!busy });
      del.addEventListener('click', () => void this.removeDetail(rec));
      const item = h('div', { class: 'wl-detail' },
        h('div', { class: 'wl-detail-main' },
          h('b', { text: r.title }),
          h('span', { class: 'muted', text: `${r.date} · ${r.voxelSize} · interior ${r.interior} · facade ${r.facade} · ${r.size}` })),
        h('div', { class: 'row' }, open, del));
      item.dataset.detail = r.id;
      det.append(item);
    }
    return det;
  }

  private async open(w: WorldMeta): Promise<void> {
    this.busyId = w.id;
    this.render();
    try { await this.hooks.openWorld(w); } finally { this.busyId = null; this.render(); }
  }

  private async remove(w: WorldMeta): Promise<void> {
    const ok = await confirmBox({
      title: `Delete "${w.name}"?`,
      message: `This permanently deletes the world and its ${w.details.length} saved detail${w.details.length === 1 ? '' : 's'} (${worldRow(w).size}) from disk.`,
      okLabel: 'Delete world', danger: true,
    });
    if (!ok) return;
    try {
      await window.voxel.deleteWorld(w.id);
      this.session.forgetWorld(w.id);
      this.hooks.onWorldDeleted(w);
      await this.session.refreshWorlds();
      toast('World deleted');
    } catch (e) {
      toast(`Delete failed: ${stripCode(errorText(e))}`, 'err');
    }
  }

  private async removeDetail(r: DetailRecord): Promise<void> {
    const rowInfo = detailRows([r])[0]!;
    const ok = await confirmBox({
      title: 'Delete saved detail?',
      message: `${rowInfo.title}, ${rowInfo.voxelSize}, interior ${rowInfo.interior} (${rowInfo.size}) will be removed from disk.`,
      okLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await this.session.deleteDetail(r);
      toast('Detail deleted');
    } catch (e) {
      toast(`Delete failed: ${stripCode(errorText(e))}`, 'err');
    }
  }
}
