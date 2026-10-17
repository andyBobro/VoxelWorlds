import type { DetailRecord, WorldMeta } from '../../shared/contract';
import { removeDetail, sortWorlds, upsertDetail, upsertWorld } from '../lib/worlds';
import { errorText } from './dom';

export interface SavedInfo { world: WorldMeta; detail?: DetailRecord }

/**
 * Renderer-side mirror of the worlds library: the list, the current world (the one shown in the city view) and its saved details.
 * The current world is only ever set explicitly (generate().world, openWorld().meta); onWorldSaved events never change it.
 */
export class WorldSession {
  worlds: WorldMeta[] = [];
  currentId: string | null = null;
  details: DetailRecord[] = [];
  loadError = '';
  private readonly listeners = new Set<() => void>();
  private readonly savedListeners = new Set<(i: SavedInfo) => void>();
  private readonly deletedListeners = new Set<(r: DetailRecord) => void>();
  private unsub: (() => void) | null = null;

  constructor() {
    this.unsub = window.voxel.onWorldSaved((e) => this.handleSaved(e));
  }

  onChange(cb: () => void): void { this.listeners.add(cb); }
  onSaved(cb: (i: SavedInfo) => void): void { this.savedListeners.add(cb); }
  onDetailDeleted(cb: (r: DetailRecord) => void): void { this.deletedListeners.add(cb); }
  /** A throwing listener must not break the others or the session state. */
  private emit(): void {
    for (const f of this.listeners) {
      try { f(); } catch (e) { console.error('session listener failed', e); }
    }
  }

  get current(): WorldMeta | null {
    return this.worlds.find((w) => w.id === this.currentId) ?? null;
  }

  async refreshWorlds(): Promise<void> {
    try {
      this.worlds = sortWorlds(await window.voxel.listWorlds());
      this.loadError = '';
    } catch (e) {
      this.loadError = errorText(e);
    }
    this.emit();
  }

  async refreshDetails(): Promise<void> {
    const id = this.currentId;
    if (!id) { this.details = []; this.emit(); return; }
    try {
      const l = await window.voxel.listDetails(id);
      if (id === this.currentId) this.details = l;
    } catch { /* keep the previous list */ }
    this.emit();
  }

  /** A world became current (generated or opened). Seeds details from the meta, then refreshes from main. */
  setCurrent(meta: WorldMeta): void {
    this.worlds = upsertWorld(this.worlds, meta);
    this.currentId = meta.id;
    this.details = meta.details ?? [];
    this.emit();
    void this.refreshDetails();
  }

  clearCurrent(): void {
    this.currentId = null;
    this.details = [];
    this.emit();
  }

  upsertDetailRecord(r: DetailRecord): void {
    if (r.worldId === this.currentId) this.details = upsertDetail(this.details, r);
    const w = this.worlds.find((x) => x.id === r.worldId);
    if (w) this.worlds = upsertWorld(this.worlds, { ...w, details: upsertDetail(w.details ?? [], r) });
    this.emit();
  }

  /** Always addressed by the record's own world id, never a global current. */
  async deleteDetail(r: DetailRecord): Promise<void> {
    await window.voxel.deleteDetail(r.worldId, r.id);
    if (r.worldId === this.currentId) this.details = removeDetail(this.details, r.id);
    const w = this.worlds.find((x) => x.id === r.worldId);
    if (w) this.worlds = upsertWorld(this.worlds, { ...w, details: removeDetail(w.details ?? [], r.id) });
    this.emit();
    for (const f of this.deletedListeners) {
      try { f(r); } catch (e) { console.error('delete listener failed', e); }
    }
  }

  /** Removes a world from the list (after deleteWorld); clears current if it was the one. */
  forgetWorld(id: string): void {
    this.worlds = this.worlds.filter((w) => w.id !== id);
    if (this.currentId === id) { this.currentId = null; this.details = []; }
    this.emit();
  }

  /** Refreshes lists only; an event for an unknown or non-current world never switches the current world. */
  private handleSaved(e: { world: WorldMeta; detail?: DetailRecord }): void {
    this.worlds = upsertWorld(this.worlds, e.world);
    if (e.world.id === this.currentId) {
      this.details = e.world.details ?? [];
      if (e.detail) this.details = upsertDetail(this.details, e.detail);
    }
    this.emit();
    for (const f of this.savedListeners) {
      try { f({ world: e.world, detail: e.detail }); } catch (err) { console.error('saved listener failed', err); }
    }
  }

  dispose(): void {
    this.unsub?.();
    this.listeners.clear();
    this.savedListeners.clear();
    this.deletedListeners.clear();
  }
}
