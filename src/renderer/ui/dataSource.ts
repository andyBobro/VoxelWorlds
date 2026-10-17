import type { BBox, DataSource, GeodataRegion, WorldMeta } from '../../shared/contract';
import {
  chooseDefaultRegion, downloadedAlternative, isCovering, downloadView, fmtBytes, loadSavedSource, saveSource, sortSuggestions, sourceAgeDays,
  sourceBlockReason,
} from '../lib/geodata';
import { fmtDate } from '../lib/worlds';
import { $ } from './dom';
import { GeodataStore } from './geodataStore';
import { h } from './h';
import { RegionPicker } from './regionPicker';

const store = (): Storage | null => {
  try { return window.localStorage; } catch { return null; }
};

/** "Data source" selector in the Generate form: Overpass (online) | local Geofabrik extract (offline) + region field. */
export class DataSourceControl {
  readonly geo = new GeodataStore();
  onChange: () => void = () => {};

  private kind: 'overpass' | 'pbf' = 'overpass';
  private regionId: string | null = null;
  private userChosen = false;
  private bbox: BBox | null = null;
  private suggestions: GeodataRegion[] = [];
  private suggestKey = '';
  /** bbox key the current `suggestions` answer is for (null = unknown / not fetched yet) */
  private suggestFor: string | null = null;
  private suggestTimer = 0;
  private readonly picker: RegionPicker;

  private readonly rOver = h('input', { type: 'radio', id: 'ds-overpass' });
  private readonly rPbf = h('input', { type: 'radio', id: 'ds-pbf' });
  private readonly regionBox = h('div', { class: 'ds-region', id: 'ds-region' });
  private readonly regionName = h('b', { id: 'ds-region-name' });
  private readonly chooseBtn = h('button', { id: 'ds-choose', text: 'Choose region...', type: 'button' });
  private readonly status = h('div', { class: 'muted ds-status', id: 'ds-status' });
  private readonly note = h('div', { class: 'ds-note', id: 'ds-note' });
  private readonly bar = h('div', { class: 'bar ds-bar', hidden: true }, h('div', { id: 'ds-bar' }));

  constructor(root: HTMLElement, private readonly worlds: () => WorldMeta[] = () => []) {
    this.rOver.name = this.rPbf.name = 'data-source';
    this.rOver.value = 'overpass';
    this.rPbf.value = 'pbf';
    const opt = (input: HTMLInputElement, label: string): HTMLElement =>
      h('label', { class: 'ds-opt', for: input.id }, input, h('span', { text: label }));
    root.append(
      h('div', { class: 'ds-head muted', text: 'Data source' }),
      h('div', { class: 'ds-opts', role: 'radiogroup' }, opt(this.rOver, 'Overpass API (online)'), opt(this.rPbf, 'Local Geofabrik extract (offline)')),
      this.regionBox,
    );
    this.regionBox.append(
      h('div', { class: 'ds-line' }, h('span', { class: 'muted', text: 'Region' }), this.regionName, this.chooseBtn),
      this.bar, this.status, this.note,
    );
    const s = loadSavedSource(store());
    this.kind = s.kind;
    this.regionId = s.regionId ?? null;
    this.userChosen = !!s.regionId;
    this.rOver.addEventListener('change', () => this.setKind('overpass'));
    this.rPbf.addEventListener('change', () => this.setKind('pbf'));
    this.picker = new RegionPicker({
      store: this.geo,
      suggestions: () => ({ list: this.suggestions, hasBBox: !!this.bbox }),
      chosenId: () => this.regionId,
      onChoose: (id) => this.choose(id, true),
      worldsUsing: (id) => this.worlds().filter((w) => w.params?.dataSource?.kind === 'pbf' && w.params.dataSource.regionId === id),
    });
    this.chooseBtn.addEventListener('click', () => this.picker.open());
    this.geo.onChange(() => { this.render(); this.onChange(); });
    void this.geo.init().then(() => { this.fetchSuggestions(); });
    this.render();
  }

  // ---- state

  /** Only called from explicit user actions (radio, region choice): never at startup. */
  private setKind(k: 'overpass' | 'pbf'): void {
    this.kind = k;
    if (k === 'pbf') this.autoPick();
    this.persist();
    this.render();
    this.onChange();
  }

  private choose(id: string, byUser: boolean): void {
    this.regionId = id;
    this.userChosen = byUser;
    this.persist();
    this.render();
    this.onChange();
  }

  private autoPick(): void {
    if (this.userChosen && this.regionId) return;
    const d = chooseDefaultRegion(this.suggestions);
    if (d) { this.regionId = d.id; this.userChosen = false; }
  }

  private persist(): void {
    saveSource(store(), { kind: this.kind, ...(this.regionId && this.userChosen ? { regionId: this.regionId } : {}) });
  }

  /** Set programmatically (opened world / "Load parameters"). */
  setSource(ds: DataSource | undefined): void {
    if (ds?.kind === 'pbf') { this.kind = 'pbf'; this.regionId = ds.regionId; this.userChosen = true; }
    else this.kind = 'overpass';
    this.render();
    this.onChange();
  }

  getSource(): DataSource {
    return this.kind === 'pbf' && this.regionId ? { kind: 'pbf', regionId: this.regionId } : { kind: 'overpass' };
  }

  /** '' when generate may run with the chosen source. */
  blockReason(): string {
    if (this.kind !== 'pbf') return '';
    const regions = new Map(this.geo.byId);
    if (this.regionId && !regions.has(this.regionId)) for (const r of this.suggestions) regions.set(r.id, r);
    const cov = this.coverageProblem();
    if (cov) return cov; // more useful than 'download it first' for a region that cannot be used here anyway
    return sourceBlockReason({ kind: 'pbf', regionId: this.regionId ?? '' }, regions, this.geo.downloadedIds, this.geo.activeId);
  }

  /** '' when covered or unknown; a reason when the answer for the current bbox says the chosen region does not cover it. */
  private coverageProblem(): string {
    if (!this.bbox || !this.regionId || this.suggestFor === null) return '';
    const hit = this.suggestions.find((x) => x.id === this.regionId);
    if (hit && isCovering(hit)) return '';
    const name = this.geo.byId.get(this.regionId)?.name ?? this.regionId;
    const best = chooseDefaultRegion(this.suggestions);
    const what = hit ? `${name} only overlaps the drawn area` : `${name} does not cover the drawn area`;
    return best ? `${what} - choose ${best.name} or a larger region` : `${what}; no Geofabrik region covers it - use Overpass or a smaller area`;
  }

  setBBox(b: BBox | null): void {
    this.bbox = b;
    window.clearTimeout(this.suggestTimer);
    this.suggestTimer = window.setTimeout(() => this.fetchSuggestions(), 250);
  }

  private fetchSuggestions(): void {
    const b = this.bbox;
    const key = b ? `${b.latMin},${b.lonMin},${b.latMax},${b.lonMax}` : '';
    if (!b) {
      this.suggestions = [];
      this.suggestKey = '';
      this.suggestFor = null;
      this.render();
      this.picker.refresh();
      return;
    }
    this.suggestKey = key;
    this.suggestFor = null; // unknown until the answer for this bbox arrives
    void this.geo.suggest(b).then((l) => {
      if (l === null || key !== this.suggestKey) return;
      this.suggestions = sortSuggestions(l);
      this.suggestFor = key;
      if (this.kind === 'pbf') this.autoPick();
      this.render();
      this.picker.refresh();
      this.onChange();
    });
  }

  // ---- view

  private render(): void {
    this.rOver.checked = this.kind === 'overpass';
    this.rPbf.checked = this.kind === 'pbf';
    this.regionBox.hidden = this.kind !== 'pbf';
    if (this.kind !== 'pbf') return;
    const g = this.geo;
    const r = this.regionId ? g.byId.get(this.regionId) ?? this.suggestions.find((x) => x.id === this.regionId) : undefined;
    this.regionName.textContent = this.regionId ? (r?.name ?? this.regionId) : 'none chosen';
    const entry = this.regionId ? g.entries.get(this.regionId) : undefined;
    const dl = this.regionId ? g.downloads.get(this.regionId) : undefined;
    const running = !!dl && (dl.phase === 'running' || dl.phase === 'cancelling');

    this.bar.hidden = !running;
    if (running && dl) {
      const v = dl.progress ? downloadView(dl.progress) : null;
      $('ds-bar').style.width = `${v?.pct ?? 0}%`;
    }
    if (!this.regionId) this.status.textContent = this.suggestions.length || !this.bbox ? 'Choose the region that covers your area.' : 'No Geofabrik region covers the drawn area.';
    else if (running && dl) {
      const v = dl.progress ? downloadView(dl.progress) : null;
      this.status.textContent = v ? `Downloading ${v.pct !== null ? `${v.pct.toFixed(0)}% ` : ''}${v.amount} ${v.speed}${v.eta ? ` ETA ${v.eta}` : ''}`.trim() : 'Downloading...';
    } else if (entry) {
      const age = sourceAgeDays(entry);
      this.status.textContent = `Downloaded (${fmtBytes(entry.sizeBytes)}), OSM data ${entry.sourceDate ? fmtDate(entry.sourceDate).slice(0, 10) : 'of unknown date'}${age !== null ? `, ${age} d old` : ''}`;
    } else this.status.textContent = `Not downloaded${r?.sizeBytes !== undefined ? ` (${fmtBytes(r.sizeBytes)})` : ''}. Open Choose region... to download.`;

    // coverage hint
    this.note.replaceChildren();
    const bestCover = this.coverageProblem() ? chooseDefaultRegion(this.suggestions) : null;
    if (bestCover) {
      const best = bestCover;
      const use = h('button', { class: 'linkish', text: `Use ${best.name}`, type: 'button' });
      use.addEventListener('click', () => this.choose(best.id, true));
      this.note.append(h('div', { class: 'warn', text: `${this.coverageProblem().split(' - ')[0]}. ` }, use));
    } else if (this.bbox && this.regionId) {
      const alt = downloadedAlternative(this.suggestions, g.downloadedIds, this.regionId);
      if (alt && !entry) {
        const use = h('button', { class: 'linkish', text: `Use ${alt.name}`, type: 'button' });
        use.addEventListener('click', () => this.choose(alt.id, true));
        this.note.append(h('div', { class: 'muted', text: `${alt.name} covers this area and is already downloaded. ` }, use));
      }
    }
    if (g.catalogueError && !g.loaded) this.note.append(h('div', { class: 'muted', text: g.catalogueError }));
  }
}
