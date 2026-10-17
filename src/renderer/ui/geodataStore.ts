import type { BBox, GeodataEntry, GeodataProgress, GeodataRegion } from '../../shared/contract';
import { errorText } from './dom';

export interface DownloadState {
  phase: 'running' | 'cancelling' | 'failed' | 'cancelled';
  progress: GeodataProgress | null;
  /** bytes already on disk from a previous attempt (resume hint) */
  resumeBytes: number;
  error?: string;
}

export const OFFLINE_TEXT = 'Geofabrik is not reachable (offline?). Regions you already downloaded still work.';

/** Friendly text for catalogue/download failures (main reports e.g. "DOWNLOAD_FAILED: getaddrinfo ENOTFOUND ..."). */
export function friendlyGeoError(raw: string): string {
  const m = raw.replace(/^[A-Z_]+:\s*/, '');
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|network|offline|fetch failed|timed? ?out|ETIMEDOUT/i.test(m)) {
    return OFFLINE_TEXT;
  }
  if (/ENOSPC|no space/i.test(m)) return 'Not enough free disk space for this download.';
  if (/md5|checksum|verify/i.test(m)) return 'The download failed its checksum check. Retry to download it again.';
  return m || 'The operation failed.';
}

/** Renderer-side state for the Geofabrik catalogue, downloaded extracts and running downloads. */
export class GeodataStore {
  regions: GeodataRegion[] = [];
  byId = new Map<string, GeodataRegion>();
  entries = new Map<string, GeodataEntry>();
  downloads = new Map<string, DownloadState>();
  catalogueError = '';
  /** when the list on screen was last fetched successfully in this session (the API has no catalogue date) */
  catalogueOkAt: number | null = null;
  loading = false;
  loaded = false;
  /** true once listGeodata() answered at least once (until then 'not downloaded' is unknown) */
  entriesLoaded = false;
  private readonly listeners = new Set<() => void>();
  private suggestSeq = 0;
  private unsub: (() => void) | null = null;

  constructor() {
    this.unsub = window.voxel.onGeodataProgress((e) => {
      const d = this.downloads.get(e.regionId);
      if (!d || d.phase === 'failed' || d.phase === 'cancelled') return;
      if (e.phase === 'error') return; // error events carry no trustworthy byte count; keep the last real one for resume
      d.progress = e;
      this.emit();
    });
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(): void {
    for (const f of this.listeners) f();
  }

  get downloadedIds(): Set<string> {
    return new Set(this.entries.keys());
  }
  /** The region currently downloading (one at a time), or null. */
  get activeId(): string | null {
    for (const [id, d] of this.downloads) if (d.phase === 'running' || d.phase === 'cancelling') return id;
    return null;
  }

  async init(): Promise<void> {
    await Promise.all([this.refreshEntries(), this.loadCatalogue(false)]);
  }

  async refreshEntries(): Promise<void> {
    try {
      const l = await window.voxel.listGeodata();
      this.entries = new Map(l.map((e) => [e.regionId, e]));
      this.entriesLoaded = true;
    } catch { /* keep what we have */ }
    this.emit();
  }

  async loadCatalogue(refresh: boolean): Promise<void> {
    this.loading = true;
    this.emit();
    try {
      const l = await window.voxel.listGeodataRegions(refresh ? { refresh: true } : undefined);
      this.regions = l;
      this.byId = new Map(l.map((r) => [r.id, r]));
      this.catalogueError = '';
      this.loaded = true;
      this.catalogueOkAt = Date.now();
    } catch (e) {
      // keep the previous (cached) list when a refresh fails
      this.catalogueError = friendlyGeoError(errorText(e));
      if (refresh && !this.loaded) {
        try { // an explicit refresh may reject while a normal list call still answers from the local cache
          const l = await window.voxel.listGeodataRegions();
          this.regions = l;
          this.byId = new Map(l.map((r) => [r.id, r]));
          this.loaded = true;
        } catch { /* no cache either */ }
      }
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  /** Smallest-first covering regions. Stale answers (bbox changed meanwhile) resolve to null. */
  async suggest(bbox: BBox): Promise<GeodataRegion[] | null> {
    const seq = ++this.suggestSeq;
    try {
      const l = await window.voxel.suggestGeodataRegions(bbox);
      return seq === this.suggestSeq ? l : null;
    } catch {
      return null; // unknown (not 'no region covers it'): callers keep what they had
    }
  }

  async download(regionId: string): Promise<GeodataEntry | null> {
    if (this.activeId) return null;
    const prev = this.downloads.get(regionId);
    this.downloads.set(regionId, { phase: 'running', progress: null, resumeBytes: prev?.progress?.receivedBytes ?? prev?.resumeBytes ?? 0 });
    this.emit();
    try {
      const entry = await window.voxel.downloadGeodata(regionId);
      this.downloads.delete(regionId);
      await this.refreshEntries();
      return entry;
    } catch (e) {
      const raw = errorText(e);
      const d = this.downloads.get(regionId);
      const got = d?.progress?.receivedBytes ?? d?.resumeBytes ?? 0;
      if (/^CANCELLED/.test(raw)) this.downloads.set(regionId, { phase: 'cancelled', progress: null, resumeBytes: got });
      else this.downloads.set(regionId, { phase: 'failed', progress: null, resumeBytes: got, error: friendlyGeoError(raw) });
      this.emit();
      return null;
    }
  }

  async cancel(regionId: string): Promise<void> {
    const d = this.downloads.get(regionId);
    if (!d || d.phase !== 'running') return;
    d.phase = 'cancelling';
    this.emit();
    try { await window.voxel.cancelGeodataDownload(regionId); } catch { /* the download promise reports the outcome */ }
  }

  async remove(regionId: string): Promise<string> {
    try {
      await window.voxel.deleteGeodata(regionId);
      this.downloads.delete(regionId);
      await this.refreshEntries();
      return '';
    } catch (e) {
      return errorText(e);
    }
  }

  dispose(): void {
    this.unsub?.();
    this.listeners.clear();
  }
}
