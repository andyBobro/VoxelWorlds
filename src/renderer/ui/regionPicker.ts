import type { GeodataRegion, WorldMeta } from '../../shared/contract';
import {
  ancestorIds, buildRegionTree, chooseDefaultRegion, downloadView, flattenTree, isCovering, fmtBytes, needsDownloadConfirm, regionPath, searchRegions, sortSuggestions,
  sourceAgeDays, type RegionRow,
} from '../lib/geodata';
import { fmtDate } from '../lib/worlds';
import { h } from './h';
import { confirmBox, openModal, type ModalHandle } from './modal';
import { toast } from './toast';
import { OFFLINE_TEXT, type GeodataStore } from './geodataStore';

export interface PickerDeps {
  store: GeodataStore;
  /** current suggestion list for the drawn bbox; null while unknown (no bbox) */
  suggestions(): { list: GeodataRegion[]; hasBBox: boolean };
  chosenId(): string | null;
  onChoose(regionId: string): void;
  /** saved worlds built from this region's extract (they lose the ability to create new details when it is deleted) */
  worldsUsing(regionId: string): WorldMeta[];
}

/** Modal: searchable region tree, suggestions for the bbox, download / cancel / resume / delete with progress. */
export class RegionPicker {
  private modal: ModalHandle | null = null;
  private selected: string | null = null;
  private expanded = new Set<string>();
  private query = '';
  private unsub: (() => void) | null = null;
  private listSig = '';

  private search = h('input', { type: 'text', placeholder: 'Search regions (e.g. Switzerland, Berlin)...' });
  private catalogueMsg = h('div', { class: 'muted rp-cat' });
  private refreshBtn = h('button', { class: 'rp-refresh', text: 'Refresh catalogue', title: 'Re-download the Geofabrik region list' });
  private list = h('div', { class: 'rp-list', role: 'listbox' });
  private detail = h('div', { class: 'rp-detail' });

  constructor(private readonly d: PickerDeps) {
    this.search.setAttribute('aria-label', 'Search regions');
    this.search.addEventListener('input', () => { this.query = this.search.value; this.renderList(); });
    this.refreshBtn.addEventListener('click', () => void d.store.loadCatalogue(true));
  }

  get isOpen(): boolean { return this.modal !== null; }

  open(): void {
    if (this.modal) return;
    this.selected = this.d.chosenId() ?? chooseDefaultRegion(this.d.suggestions().list)?.id ?? null;
    this.query = '';
    this.search.value = '';
    this.expanded = new Set(this.selected ? ancestorIds(this.d.store.byId, this.selected) : []);
    this.modal = openModal('Choose a Geofabrik region', { wide: true, onClose: () => this.close(), cls: 'region-picker' });
    this.modal.body.append(
      h('div', { class: 'rp-top' }, this.search, this.refreshBtn),
      this.catalogueMsg, this.list, this.detail,
    );
    this.unsub = this.d.store.onChange(() => this.onStore());
    this.listSig = '';
    this.renderList();
    this.renderDetail();
    this.search.focus();
    if (!this.d.store.loaded && !this.d.store.loading) void this.d.store.loadCatalogue(false);
  }

  close(): void {
    this.unsub?.();
    this.unsub = null;
    this.modal?.close();
    this.modal = null;
  }

  /** Called by the owner when the bbox suggestions changed. */
  refresh(): void {
    if (this.modal) { this.renderList(); this.renderDetail(); }
  }

  private sig(): string {
    const s = this.d.store;
    return `${s.regions.length}|${[...s.entries.keys()].sort().join(',')}|${s.loaded}|${s.loading}|${s.catalogueError}|${s.activeId ?? ''}`;
  }
  private onStore(): void {
    const sig = this.sig();
    if (sig !== this.listSig) this.renderList();
    this.renderDetail();
  }

  // ---- list

  /** catalogue size, else the size of the downloaded file */
  private sizeOf(r: GeodataRegion): number | undefined {
    return r.sizeBytes ?? this.d.store.entries.get(r.id)?.sizeBytes;
  }

  private row(r: GeodataRegion, depth: number, o: { path?: string; caret?: 'open' | 'closed' | null; suggest?: boolean }): HTMLElement {
    const store = this.d.store;
    const dl = store.entries.has(r.id) || r.downloaded;
    const active = store.downloads.get(r.id);
    const caret = h('span', { class: `rp-caret ${o.caret ? 'has' : ''}`, text: o.caret === 'open' ? '▾' : o.caret === 'closed' ? '▸' : '' });
    const el = h('div', { class: `rp-row ${this.selected === r.id ? 'sel' : ''}`, role: 'option' },
      caret,
      h('span', { class: 'rp-name', text: r.name }),
      o.path ? h('span', { class: 'muted rp-path', text: o.path }) : null,
      h('span', { class: 'rp-size muted', text: this.sizeOf(r) !== undefined ? fmtBytes(this.sizeOf(r)) : 'size unknown' }),
      dl ? h('span', { class: 'badge ok', text: 'Downloaded' }) : active && (active.phase === 'running' || active.phase === 'cancelling')
        ? h('span', { class: 'badge', text: 'Downloading' }) : null,
      this.d.chosenId() === r.id ? h('span', { class: 'badge sel', text: 'In use' }) : null,
    );
    el.style.paddingLeft = `${6 + depth * 16}px`;
    el.dataset.region = r.id;
    el.setAttribute('aria-selected', String(this.selected === r.id));
    caret.addEventListener('click', (e) => {
      if (!o.caret) return;
      e.stopPropagation();
      if (this.expanded.has(r.id)) this.expanded.delete(r.id); else this.expanded.add(r.id);
      this.renderList();
    });
    el.addEventListener('click', () => { this.selected = r.id; this.renderList(); this.renderDetail(); });
    el.addEventListener('dblclick', () => { this.choose(r.id); });
    return el;
  }

  private renderList(): void {
    const store = this.d.store;
    this.listSig = this.sig();
    const top = this.list.scrollTop;
    this.list.replaceChildren();
    this.refreshBtn.disabled = store.loading;
    this.refreshBtn.textContent = store.loading ? 'Loading...' : 'Refresh catalogue';

    const sg = this.d.suggestions();
    if (sg.hasBBox) {
      const l = sortSuggestions(sg.list);
      const cover = l.filter(isCovering), overlap = l.filter((r) => !isCovering(r));
      this.list.append(h('div', { class: 'rp-sec', text: 'Covers the area (smallest first)' }));
      if (!cover.length) this.list.append(h('div', { class: 'muted rp-empty', text: store.catalogueError && !store.loaded ? 'Suggestions need the region catalogue.' : 'No Geofabrik region covers the whole area.' }));
      for (const r of cover) this.list.append(this.row(r, 0, { path: regionPath(store.byId, r.id), suggest: true }));
      if (overlap.length) {
        this.list.append(h('div', { class: 'rp-sec', text: 'Overlaps the area (part of it is outside the region)' }));
        for (const r of overlap) this.list.append(this.row(r, 0, { path: regionPath(store.byId, r.id), suggest: true }));
      }
    } else {
      this.list.append(h('div', { class: 'muted rp-empty', text: 'Draw an area on the map to get suggestions.' }));
    }

    this.list.append(h('div', { class: 'rp-sec', text: this.query.trim() ? 'Search results' : 'All regions' }));
    if (!store.loaded && store.loading) this.list.append(h('div', { class: 'muted rp-empty', text: 'Loading region catalogue...' }));
    else if (!store.loaded) this.list.append(h('div', { class: 'muted rp-empty', text: 'The region catalogue is not available.' }));
    else {
      let rows: RegionRow[];
      if (this.query.trim()) {
        rows = searchRegions(store.regions, this.query);
        if (!rows.length) this.list.append(h('div', { class: 'muted rp-empty', text: `No region matches "${this.query.trim()}".` }));
      } else rows = flattenTree(buildRegionTree(store.regions), this.expanded);
      for (const r of rows) {
        this.list.append(this.row(r.region, r.depth, {
          path: this.query.trim() ? r.path : undefined,
          caret: !this.query.trim() && r.hasChildren ? (r.expanded ? 'open' : 'closed') : null,
        }));
      }
    }
    this.list.scrollTop = top;

    const cm = store.catalogueError;
    const when = store.catalogueOkAt ? ` from ${fmtDate(new Date(store.catalogueOkAt).toISOString())}` : '';
    const lead = cm === OFFLINE_TEXT ? "Couldn't refresh (offline)." : `Couldn't refresh: ${cm}`;
    this.catalogueMsg.textContent = cm ? (store.loaded ? `${lead} Showing the saved list${when}.` : cm) : store.loaded ? `${store.regions.length} regions` : '';
    this.catalogueMsg.classList.toggle('warn-text', !!cm);
  }

  // ---- detail footer

  private choose(id: string): void {
    this.d.onChoose(id);
    this.close();
  }

  private renderDetail(): void {
    const store = this.d.store;
    this.detail.replaceChildren();
    const r = this.selected ? store.byId.get(this.selected) ?? this.d.suggestions().list.find((x) => x.id === this.selected) : undefined;
    if (!r) {
      this.detail.append(h('div', { class: 'muted', text: 'Select a region to see its size and download it.' }));
      return;
    }
    const entry = store.entries.get(r.id);
    const dl = store.downloads.get(r.id);
    const other = store.activeId && store.activeId !== r.id;
    const running = dl && (dl.phase === 'running' || dl.phase === 'cancelling');
    const path = regionPath(store.byId, r.id);

    this.detail.append(h('div', { class: 'rp-title' }, h('b', { text: r.name }), h('span', { class: 'muted', text: path ? ` ${path}` : '' })));
    const size = this.sizeOf(r);
    const info: string[] = [`Size: ${size !== undefined ? fmtBytes(size) : 'unknown'}`];
    if (entry) {
      const age = sourceAgeDays(entry);
      info.push(`Downloaded ${fmtDate(entry.downloadedAt)}`);
      info.push(`OSM data from ${entry.sourceDate ? fmtDate(entry.sourceDate).slice(0, 10) : 'unknown date'}${age !== null ? ` (${age} day${age === 1 ? '' : 's'} old)` : ''}`);
      if (!entry.verified) info.push('checksum not available');
    }
    this.detail.append(h('div', { class: 'muted rp-info', text: info.join(' | ') }));

    if (running && dl) {
      const v = dl.progress ? downloadView(dl.progress) : null;
      const bar = h('div', { class: `bar ${v && v.pct === null ? 'indet' : ''}` }, h('div', { class: 'rp-bar', style: `width:${v?.pct ?? 0}%` }));
      const txt = !v ? 'Starting...' : dl.phase === 'cancelling' ? 'Cancelling...' : v.phase === 'verify' ? v.message || 'Verifying...'
        : [v.pct !== null ? `${v.pct.toFixed(0)}%` : '', v.amount, v.speed, v.eta ? `ETA ${v.eta}` : ''].filter(Boolean).join(' - ');
      this.detail.append(bar, h('div', { class: 'rp-prog', text: txt }));
      const cancel = h('button', { text: dl.phase === 'cancelling' ? 'Cancelling...' : 'Cancel download', disabled: dl.phase === 'cancelling' });
      cancel.addEventListener('click', () => void store.cancel(r.id));
      this.detail.append(h('div', { class: 'row buttons' }, cancel));
      return;
    }

    if (dl?.phase === 'failed') this.detail.append(h('div', { class: 'warn err', text: `Download failed: ${(dl.error ?? 'unknown error').replace(/[.!?]?$/, '.')} Retry resumes where it stopped.` }));
    else if (dl?.phase === 'cancelled') this.detail.append(h('div', { class: 'muted', text: `Download cancelled at ${fmtBytes(dl.resumeBytes)}. It will resume from there.` }));

    const buttons = h('div', { class: 'row buttons' });
    if (entry) {
      const del = h('button', { class: 'danger', text: 'Delete downloaded data' });
      del.addEventListener('click', () => void this.confirmDelete(r, entry.sizeBytes));
      const use = h('button', { class: 'primary', text: this.d.chosenId() === r.id ? 'Close' : 'Use this region' });
      use.addEventListener('click', () => this.choose(r.id));
      buttons.append(del, use);
    } else {
      const resumeBytes = dl?.resumeBytes ?? 0;
      const label = resumeBytes > 0
        ? `Resume download (${fmtBytes(resumeBytes)}${r.sizeBytes !== undefined ? ` of ${fmtBytes(r.sizeBytes)}` : ' so far'})`
        : `Download${r.sizeBytes !== undefined ? ` (${fmtBytes(r.sizeBytes)})` : ''}`;
      const down = h('button', { class: 'primary', text: label, disabled: !!other });
      if (other) down.title = 'Another download is running';
      down.addEventListener('click', () => void this.startDownload(r));
      const use = h('button', { text: 'Use this region' });
      use.title = 'Generate stays disabled until the extract is downloaded';
      use.addEventListener('click', () => this.choose(r.id));
      buttons.append(use, down);
    }
    this.detail.append(buttons);
  }

  private async startDownload(r: GeodataRegion): Promise<void> {
    const resuming = (this.d.store.downloads.get(r.id)?.resumeBytes ?? 0) > 0; // already confirmed once
    if (!resuming && needsDownloadConfirm(r.sizeBytes)) {
      const unknown = r.sizeBytes === undefined;
      const hasKids = [...this.d.store.regions].some((x) => x.parent === r.id);
      const ok = await confirmBox({
        title: unknown ? `Download ${r.name}? (size unknown)` : `Download ${r.name}?`,
        message: unknown
          ? `The size of this extract is unknown. ${hasKids ? 'It covers a whole region with sub-regions, so it' : 'It'} can be several GB and take a long time. It is stored on this computer, can be resumed if interrupted, and works offline afterwards. Consider a smaller sub-region.`
          : `This extract is ${fmtBytes(r.sizeBytes)}. It is stored on this computer, can be resumed if interrupted, and works offline afterwards. Make sure you have enough disk space and bandwidth.`,
        okLabel: unknown ? 'Download anyway' : `Download ${fmtBytes(r.sizeBytes)}`,
      });
      if (!ok) return;
    }
    const entry = await this.d.store.download(r.id);
    if (entry) toast(`${r.name} downloaded`);
  }

  private usersNote(regionId: string): string {
    const ws = this.d.worldsUsing(regionId);
    if (!ws.length) return '';
    const names = ws.slice(0, 6).map((w) => `"${w.name}"`).join(', ') + (ws.length > 6 ? `, and ${ws.length - 6} more` : '');
    return ` Saved worlds built from it (${names}) stay viewable, but cannot create new building details until the extract is downloaded again.`;
  }

  private async confirmDelete(r: GeodataRegion, bytes: number): Promise<void> {
    const ok = await confirmBox({
      title: `Delete ${r.name}?`,
      message: `This removes the downloaded extract (${fmtBytes(bytes)}) from disk. You can download it again later.${this.usersNote(r.id)}`,
      okLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    const err = await this.d.store.remove(r.id);
    toast(err ? `Delete failed: ${err}` : `${r.name} deleted`, err ? 'err' : 'ok');
  }
}
