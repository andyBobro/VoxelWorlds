import type { BBox, BuildingInfo, DetailRecord, WorldMeta } from '../../shared/contract';
import { fmtBytes } from './geodata';

/** Pure models for the Worlds library and saved-detail lists (no DOM). */

const byUpdatedDesc = (a: WorldMeta, b: WorldMeta): number => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
const byCreatedDesc = (a: DetailRecord, b: DetailRecord): number => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

/** Insert or replace a world, newest first. Returns a new array. */
export function upsertWorld(list: readonly WorldMeta[], w: WorldMeta): WorldMeta[] {
  return [...list.filter((x) => x.id !== w.id), w].sort(byUpdatedDesc);
}
export function sortWorlds(list: readonly WorldMeta[]): WorldMeta[] {
  return [...list].sort(byUpdatedDesc);
}

/** Insert or replace a detail record (dedupes the detail() result against the onWorldSaved event), newest first. */
export function upsertDetail(list: readonly DetailRecord[], r: DetailRecord): DetailRecord[] {
  return [...list.filter((x) => x.id !== r.id), r].sort(byCreatedDesc);
}
export function removeDetail(list: readonly DetailRecord[], id: string): DetailRecord[] {
  return list.filter((x) => x.id !== id);
}

/** buildingId -> records (newest first). */
export function groupDetailsByBuilding(records: readonly DetailRecord[]): Map<string, DetailRecord[]> {
  const m = new Map<string, DetailRecord[]>();
  for (const r of [...records].sort(byCreatedDesc)) {
    const l = m.get(r.buildingId);
    if (l) l.push(r); else m.set(r.buildingId, [r]);
  }
  return m;
}

/** Buildings of the index that have at least one saved detail (drives the 3D markers). Records of unknown buildings are ignored. */
export function markedBuildings(buildings: readonly BuildingInfo[], records: readonly DetailRecord[]): BuildingInfo[] {
  const g = groupDetailsByBuilding(records);
  return buildings.filter((b) => g.has(b.id));
}

export function bboxCentre(b: BBox): { lat: number; lon: number } {
  return { lat: (b.latMin + b.latMax) / 2, lon: (b.lonMin + b.lonMax) / 2 };
}
export function fmtCentre(b: BBox): string {
  const c = bboxCentre(b);
  return `${Math.abs(c.lat).toFixed(4)}°${c.lat >= 0 ? 'N' : 'S'} ${Math.abs(c.lon).toFixed(4)}°${c.lon >= 0 ? 'E' : 'W'}`;
}
export function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso ?? '?');
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fmtVoxelSize(v: number): string {
  return `${Number(v.toFixed(3))} m`;
}

export interface WorldRow {
  id: string;
  name: string;
  date: string;
  centre: string;
  voxels: string;
  buildings: string;
  details: number;
  size: string;
  voxelSize: string;
  source: string;
}
const n0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const loc = (v: unknown): string => n0(v).toLocaleString('en-US');

/** Never throws: legacy or partial metas show placeholders instead of breaking the whole list. */
export function worldRow(w: WorldMeta): WorldRow {
  const src = w.params?.dataSource;
  const b = w.bbox ?? w.params?.bbox;
  return {
    id: String(w.id ?? ''), name: w.name || 'Untitled world', date: w.createdAt ? fmtDate(w.createdAt) : '?',
    centre: b && Number.isFinite(b.latMin) && Number.isFinite(b.lonMax) ? fmtCentre(b) : '?',
    voxels: loc(w.stats?.voxelCount), buildings: loc(w.stats?.buildingCount),
    details: Array.isArray(w.details) ? w.details.length : 0, size: fmtBytes(w.sizeBytes), voxelSize: fmtVoxelSize(n0(w.voxelSize ?? w.params?.voxelSize)),
    source: src && src.kind === 'pbf' ? `Geofabrik: ${src.regionId}` : 'Overpass',
  };
}

export interface DetailRow {
  id: string;
  buildingId: string;
  title: string;
  date: string;
  voxelSize: string;
  interior: 'yes' | 'no';
  facade: string;
  size: string;
  voxels: string;
}
/** Display rows for saved details, newest first. */
export function detailRows(records: readonly DetailRecord[]): DetailRow[] {
  return [...records].sort(byCreatedDesc).map((r) => ({
    id: r.id, buildingId: r.buildingId, title: r.buildingName?.trim() || r.buildingId,
    date: fmtDate(r.createdAt), voxelSize: fmtVoxelSize(n0(r.voxelSize)), interior: r.interior ? 'yes' : 'no',
    facade: r.facade ? `wall ${n0(r.facade.edge) + 1}` : 'none', size: fmtBytes(r.sizeBytes), voxels: loc(r.stats?.voxelCount),
  }));
}

/** Short one-line summary used in the building panel list. */
export function detailSummary(row: DetailRow): string {
  return `${row.voxelSize}, interior ${row.interior}, facade ${row.facade}, ${row.size}`;
}

export type WorldSort = 'newest' | 'name' | 'size';

/** Case-insensitive match on name, source region and centre text. */
export function filterWorlds(list: readonly WorldMeta[], query: string): WorldMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((w) => {
    const ds = w.params?.dataSource;
    const hay = `${w.name ?? ''} ${ds && ds.kind === 'pbf' ? ds.regionId : 'overpass'} ${w.bbox ? fmtCentre(w.bbox) : ''} ${w.createdAt ?? ''}`.toLowerCase();
    return hay.includes(q);
  });
}

export function sortWorldsBy(list: readonly WorldMeta[], by: WorldSort): WorldMeta[] {
  const l = [...list];
  if (by === 'name') l.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'en', { numeric: true }) || a.id.localeCompare(b.id));
  else if (by === 'size') l.sort((a, b) => n0(b.sizeBytes) - n0(a.sizeBytes) || a.id.localeCompare(b.id));
  else l.sort(byUpdatedDesc);
  return l;
}

export function fmtBytesTotal(list: readonly WorldMeta[]): string {
  return fmtBytes(list.reduce((s, w) => s + n0(w.sizeBytes), 0));
}

/** Marker legend text: "Saved details: 2 on 1 building". */
export function markerLegend(details: number, buildings: number): string {
  return `Saved details: ${details} on ${buildings} building${buildings === 1 ? '' : 's'}`;
}

export const LIBRARY_WARN_BYTES = 1_500_000_000;
const BYTES_PER_DETAIL_VOXEL = 20;
const DETAIL_SIZE_NOTE_BYTES = 10_000_000;

/** Rough on-disk size of a saved detail (.vwg + metadata), ~20 B per voxel. */
export function detailLibraryBytes(voxels: number): number {
  return Math.max(0, Math.round(voxels)) * BYTES_PER_DETAIL_VOXEL;
}
/** Inline note for big details, or null below ~10 MB. */
export function detailSizeNote(voxels: number): string | null {
  const b = detailLibraryBytes(voxels);
  return b > DETAIL_SIZE_NOTE_BYTES ? `This detail will use about ${fmtBytes(b)} in your library.` : null;
}
export function libraryTooBig(list: readonly WorldMeta[]): boolean {
  return list.reduce((s, w) => s + n0(w.sizeBytes), 0) > LIBRARY_WARN_BYTES;
}
