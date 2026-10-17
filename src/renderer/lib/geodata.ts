import type { BBox, DataSource, GeodataEntry, GeodataProgress, GeodataRegion } from '../../shared/contract';

/** Pure helpers for the Geofabrik region picker (no DOM). */

export const CONFIRM_DOWNLOAD_BYTES = 200_000_000;

export interface RegionNode {
  region: GeodataRegion;
  children: RegionNode[];
}
export interface RegionRow {
  region: GeodataRegion;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** "Europe > Germany" style ancestors, used for search results */
  path: string;
}

const byName = (a: GeodataRegion, b: GeodataRegion): number => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id);

/** Parent hierarchy as a forest. Regions whose parent is unknown become roots. Children sorted by name. */
export function buildRegionTree(regions: readonly GeodataRegion[]): RegionNode[] {
  const nodes = new Map<string, RegionNode>();
  for (const r of regions) nodes.set(r.id, { region: r, children: [] });
  const roots: RegionNode[] = [];
  for (const n of nodes.values()) {
    const p = n.region.parent && n.region.parent !== n.region.id ? nodes.get(n.region.parent) : undefined;
    (p ? p.children : roots).push(n);
  }
  const sort = (l: RegionNode[]): void => {
    l.sort((a, b) => byName(a.region, b.region));
    for (const n of l) sort(n.children);
  };
  sort(roots);
  return roots;
}

/** Ancestor chain names for a region ("Europe > Germany"), cycle-safe. */
export function regionPath(regions: ReadonlyMap<string, GeodataRegion>, id: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = regions.get(id)?.parent;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const r = regions.get(cur);
    if (!r) break;
    out.unshift(r.name);
    cur = r.parent;
  }
  return out.join(' > ');
}

/** Visible rows of the tree given the expanded set (no query). */
export function flattenTree(roots: readonly RegionNode[], expanded: ReadonlySet<string>): RegionRow[] {
  const rows: RegionRow[] = [];
  const walk = (list: readonly RegionNode[], depth: number, path: string): void => {
    for (const n of list) {
      const open = expanded.has(n.region.id);
      rows.push({ region: n.region, depth, hasChildren: n.children.length > 0, expanded: open, path });
      if (open) walk(n.children, depth + 1, path ? `${path} > ${n.region.name}` : n.region.name);
    }
  };
  walk(roots, 0, '');
  return rows;
}

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Case/diacritic-insensitive search over name and id; best matches first (exact, prefix, word prefix, contains). */
export function searchRegions(regions: readonly GeodataRegion[], query: string): RegionRow[] {
  const q = fold(query.trim());
  if (!q) return [];
  const byId = new Map(regions.map((r) => [r.id, r]));
  const hasKids = new Set<string>();
  for (const r of regions) if (r.parent) hasKids.add(r.parent);
  const scored: Array<{ r: GeodataRegion; s: number }> = [];
  for (const r of regions) {
    const name = fold(r.name), id = fold(r.id);
    let s = -1;
    if (name === q) s = 0;
    else if (name.startsWith(q)) s = 1;
    else if (name.split(/[\s\-/(),]+/).some((w) => w.startsWith(q))) s = 2;
    else if (name.includes(q)) s = 3;
    else if (id.includes(q)) s = 4;
    if (s >= 0) scored.push({ r, s });
  }
  scored.sort((a, b) => a.s - b.s || (a.r.sizeBytes ?? Infinity) - (b.r.sizeBytes ?? Infinity) || byName(a.r, b.r));
  return scored.map(({ r }) => ({ region: r, depth: 0, hasChildren: hasKids.has(r.id), expanded: false, path: regionPath(byId, r.id) }));
}

/** Ids of all ancestors (to auto-expand the tree down to a region). */
export function ancestorIds(regions: ReadonlyMap<string, GeodataRegion>, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = regions.get(id)?.parent;
  while (cur && !seen.has(cur) && regions.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = regions.get(cur)!.parent;
  }
  return out;
}

/**
 * main may flag suggestions that merely intersect the bbox with `covers: false` (covering ones come first).
 * A missing flag means covering (older main), so behaviour degrades to "all covering".
 * NOTE: `covers` is not in the frozen contract yet; it is read defensively.
 */
export function isCovering(r: GeodataRegion): boolean {
  return (r as GeodataRegion & { covers?: boolean }).covers !== false;
}

/** Covering regions first, then overlapping ones; within each smallest first, unknown sizes last, stable by name. */
export function sortSuggestions(list: readonly GeodataRegion[]): GeodataRegion[] {
  return [...list].sort((a, b) => Number(!isCovering(a)) - Number(!isCovering(b)) || (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity) || byName(a, b));
}

/** Default region for a bbox: the smallest region that COVERS it (never one that only overlaps; null if none covers it). */
export function chooseDefaultRegion(suggestions: readonly GeodataRegion[]): GeodataRegion | null {
  return sortSuggestions(suggestions).find(isCovering) ?? null;
}

/** A covering region that is already downloaded and different from the default (offered as an offline alternative). */
export function downloadedAlternative(
  suggestions: readonly GeodataRegion[], downloaded: ReadonlySet<string>, chosenId: string | null,
): GeodataRegion | null {
  return sortSuggestions(suggestions).find((r) => isCovering(r) && downloaded.has(r.id) && r.id !== chosenId) ?? null;
}

export function needsDownloadConfirm(sizeBytes: number | undefined): boolean {
  return sizeBytes === undefined || sizeBytes > CONFIRM_DOWNLOAD_BYTES;
}

export function fmtBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return '?';
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(0)} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}
export function fmtSpeed(bps: number | undefined): string {
  return bps === undefined || !Number.isFinite(bps) || bps <= 0 ? '' : `${fmtBytes(bps)}/s`;
}
/** Seconds -> "1 h 05 min", "3 min 20 s", "45 s"; '' when unknown. */
export function fmtEta(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
}

export interface DownloadView {
  /** 0..100 or null when total unknown */
  pct: number | null;
  /** "123 MB of 380 MB" */
  amount: string;
  speed: string;
  eta: string;
  phase: GeodataProgress['phase'];
  message: string;
}

export function downloadView(p: GeodataProgress): DownloadView {
  const total = p.totalBytes && p.totalBytes > 0 ? p.totalBytes : undefined;
  const pct = total ? Math.max(0, Math.min(100, (p.receivedBytes / total) * 100)) : null;
  const remaining = total ? Math.max(0, total - p.receivedBytes) : undefined;
  const eta = remaining !== undefined && p.bytesPerSec && p.bytesPerSec > 0 && p.phase === 'download' ? fmtEta(remaining / p.bytesPerSec) : '';
  const amount = total ? `${fmtBytes(p.receivedBytes)} of ${fmtBytes(total)}` : fmtBytes(p.receivedBytes);
  const message = p.message ?? (p.phase === 'verify' ? 'Verifying checksum...' : p.phase === 'done' ? 'Done' : '');
  return { pct, amount, speed: p.phase === 'download' ? fmtSpeed(p.bytesPerSec) : '', eta, phase: p.phase, message };
}

/** Why Generate must stay disabled for this source, or '' when it can run. */
export function sourceBlockReason(
  source: DataSource, regions: ReadonlyMap<string, GeodataRegion>, downloaded: ReadonlySet<string>, downloading: string | null,
): string {
  if (source.kind === 'overpass') return '';
  const name = regions.get(source.regionId)?.name ?? source.regionId;
  if (!source.regionId) return 'Choose a Geofabrik region for the local data source';
  if (downloading === source.regionId) return `Downloading ${name}... wait for it to finish`;
  if (!downloaded.has(source.regionId)) return `Download the ${name} extract first (Choose region...) or switch to Overpass`;
  return '';
}

export const SOURCE_KEY = 'voxelworlds.dataSource';

export interface SavedSource { kind: 'overpass' | 'pbf'; regionId?: string }
interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }

export function parseSavedSource(raw: string | null): SavedSource {
  try {
    const o = JSON.parse(raw ?? 'null') as { kind?: unknown; regionId?: unknown } | null;
    if (o && o.kind === 'pbf') return { kind: 'pbf', regionId: typeof o.regionId === 'string' && o.regionId ? o.regionId : undefined };
  } catch { /* corrupt: default */ }
  return { kind: 'overpass' };
}
export function loadSavedSource(storage: StorageLike | null | undefined): SavedSource {
  try { return parseSavedSource(storage?.getItem(SOURCE_KEY) ?? null); } catch { return { kind: 'overpass' }; }
}
export function saveSource(storage: StorageLike | null | undefined, s: SavedSource): void {
  try { storage?.setItem(SOURCE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

/** Does the extract's sourceDate look stale (older than `days`)? */
export function sourceAgeDays(entry: Pick<GeodataEntry, 'sourceDate' | 'downloadedAt'>, now = Date.now()): number | null {
  const t = Date.parse(entry.sourceDate ?? entry.downloadedAt);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null;
}

/** Stage label for the sidebar progress panel. */
export function stageLabel(stage: string, message: string): string {
  if (stage === 'pbf') return message ? `Reading local OSM data… ${message}` : 'Reading local OSM data…';
  return `${stage}: ${message}`;
}

export function sameBBox(a: BBox | null, b: BBox | null): boolean {
  return !!a && !!b && a.latMin === b.latMin && a.lonMin === b.lonMin && a.latMax === b.latMax && a.lonMax === b.lonMax;
}

/** Friendly text for backend warning events; null = no special handling (just log). */
export function friendlyWarning(code: string, message: string): { text: string; kind: 'warn' } | null {
  switch (code) {
    case 'SOURCE_CHANGED':
      return { kind: 'warn', text: 'The local extract was updated since this world was generated; buildings may differ from the saved city.' };
    case 'OSM_CACHE_STALE':
      return { kind: 'warn', text: 'Using cached OpenStreetMap data that may be out of date.' };
    case 'DETAIL_NOT_SAVED':
      return { kind: 'warn', text: `The detail was generated but could not be saved to the library${message ? ` (${message.replace(/^[A-Z_]{4,}:\s*/, '')})` : ''}.` };
    default:
      return null;
  }
}

/** The extract recorded when a world was generated differs from the one on disk now. */
export function extractChanged(
  info: { sizeBytes: number; sourceDate?: string } | undefined, entry: Pick<GeodataEntry, 'sizeBytes' | 'sourceDate'> | undefined,
): boolean {
  if (!info || !entry) return false;
  return info.sizeBytes !== entry.sizeBytes || (info.sourceDate !== undefined && entry.sourceDate !== undefined && info.sourceDate !== entry.sourceDate);
}
