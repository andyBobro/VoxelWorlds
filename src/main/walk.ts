import type { WalkSession, WorldMeta } from '../shared/contract';
import { CH } from '../shared/channels';

/**
 * Walking demo, Electron-free so it is unit-testable (ipc.ts / index.ts supply the real window).
 *
 *  - WalkManager: the single walk session (state, sender identity, cleanup on every way the window can go away).
 *  - authorize(): per-channel sender allow-list. The walk window may only use the channels it needs; while a walk is
 *    open the (locked) main window may not change world state or start jobs.
 */

/** Channels the walk window may invoke (everything else from it is BAD_REQUEST). */
export const WALK_ALLOWED: ReadonlySet<string> = new Set<string>([
  CH.readVwg,
  CH.readBuildingIndex,
  CH.openDetail,
  CH.listDetails,
  CH.detail,
  CH.cancel,
  CH.walkSession,
  CH.endWalk,
  CH.walkActive,
]);

/** Channels that only the walk window may use. */
export const WALK_ONLY: ReadonlySet<string> = new Set<string>([CH.walkSession, CH.endWalk]);

/** Channels that only the main window may use. */
export const MAIN_ONLY: ReadonlySet<string> = new Set<string>([CH.startWalk, CH.walkFocus, CH.walkExit]);

/** Channels the locked main window may not use while a walk is open (job starts and every world/library mutation). */
export const LOCKED_WHILE_WALKING: ReadonlySet<string> = new Set<string>([
  CH.generate,
  CH.cancel,
  CH.exportAs,
  CH.analyzeFacade,
  CH.detail,
  CH.pickPhoto,
  CH.openWorld,
  CH.renameWorld,
  CH.deleteWorld,
  CH.deleteDetail,
  CH.downloadGeodata,
  CH.deleteGeodata,
  CH.startWalk,
]);

export type SenderKind = 'main' | 'walk';

/**
 * Who is calling? Pure so it is testable: `isMainFrame` is `senderFrame === sender.mainFrame` (undefined = unknown, accepted).
 * Throws BAD_REQUEST for sub-frames and for webContents that are neither the walk window nor the main window.
 */
export function resolveSender(senderId: number, isMainFrame: boolean | undefined, mainId: number | undefined, walkId: number | undefined): SenderKind {
  if (isMainFrame === false) throw new Error('BAD_REQUEST: unexpected caller');
  if (walkId !== undefined && senderId === walkId) return 'walk';
  if (mainId !== undefined && senderId === mainId) return 'main';
  throw new Error('BAD_REQUEST: unknown caller');
}

/** Throws BAD_REQUEST / BUSY when `sender` may not invoke `channel` given the walk state. */
export function authorize(channel: string, sender: SenderKind, walking: boolean): void {
  if (sender === 'walk') {
    if (!walking || !WALK_ALLOWED.has(channel)) throw new Error('BAD_REQUEST: not allowed from the walking window');
    return;
  }
  if (WALK_ONLY.has(channel)) throw new Error('BAD_REQUEST: only the walking window may call this');
  if (walking && LOCKED_WHILE_WALKING.has(channel)) {
    throw new Error('BUSY: the walking view is open; close it to continue');
  }
}

/** What WalkManager needs from the OS window. */
export interface WalkWindowHandle {
  /** webContents id, to recognise the sender */
  readonly id: number;
  focus(): void;
  /** request closing; must lead to the `onGone` callback given to open() (idempotent) */
  close(): void;
  /** send an event to the walk window's renderer */
  send(channel: string, payload: unknown): void;
  /** hard destroy (used at teardown if close() did not end it) */
  destroy(): void;
}

export interface WalkDeps {
  /** create the modal window; call `onGone` when it was closed / its renderer died */
  open(session: WalkSession, onGone: (reason: string) => void): WalkWindowHandle;
  /** tell the main window (and anyone else interested) */
  broadcast(active: boolean): void;
  /** refocus the main window after the walk */
  refocusMain(): void;
  /** cancel the running job (started by the walk window) and release the slot */
  releaseJob(): void;
  log?(m: string): void;
}

export class WalkManager {
  private win: WalkWindowHandle | null = null;
  private starting = false;

  constructor(private readonly deps: WalkDeps) {}

  get active(): boolean {
    return this.win !== null || this.starting;
  }

  /** webContents id of the walk window, if open */
  get wcId(): number | undefined {
    return this.win?.id;
  }

  /** Is this webContents id the walk window? */
  isWalkSender(id: number): boolean {
    return this.win !== null && this.win.id === id;
  }

  /** Throws BUSY when a walk is already open. */
  begin(session: WalkSession): void {
    if (this.active) throw new Error('BUSY: a walking view is already open');
    this.starting = true;
    let handle: WalkWindowHandle;
    try {
      handle = this.deps.open(session, (reason) => this.end(reason));
    } catch (e) {
      this.starting = false;
      throw e;
    }
    this.starting = false;
    this.win = handle;
    this.deps.broadcast(true);
  }

  /** Close/clean up. Idempotent; safe from 'closed', 'render-process-gone', endWalk and app quit. */
  end(reason = 'ended'): void {
    const w = this.win;
    if (!w) return;
    this.win = null; // first: re-entrancy (close() -> 'closed' -> end()) is a no-op
    this.deps.log?.(`[walk] ended (${reason})`);
    try {
      this.deps.releaseJob();
    } catch (e) {
      this.deps.log?.(`[walk] releasing the job slot failed: ${String(e)}`);
    }
    try {
      w.close();
    } catch {
      /* already gone */
    }
    try {
      w.destroy();
    } catch {
      /* already gone */
    }
    this.deps.broadcast(false);
    this.deps.refocusMain();
  }

  focus(): void {
    this.win?.focus();
  }

  /** Event to the walk window (no-op when none). */
  send(channel: string, payload: unknown): void {
    this.win?.send(channel, payload);
  }
}

/** Sanity-check a requested spawn (city voxel [x, z]); undefined = world centre. */
export function cleanSpawn(spawn: unknown): { x: number; z: number } | undefined {
  if (spawn === undefined || spawn === null) return undefined;
  const s = spawn as { x?: unknown; z?: unknown };
  if (typeof s !== 'object' || typeof s.x !== 'number' || typeof s.z !== 'number' || !Number.isFinite(s.x) || !Number.isFinite(s.z)) {
    throw new Error('BAD_REQUEST: invalid spawn');
  }
  if (Math.abs(s.x) > 1e7 || Math.abs(s.z) > 1e7) throw new Error('BAD_REQUEST: invalid spawn');
  return { x: s.x, z: s.z };
}

/** Builds the WalkSession from the library (pure; paths come from the store, never from the renderer). */
export function buildSession(meta: WorldMeta, vwgPath: string, buildingIndexPath: string | undefined, spawn?: { x: number; z: number }): WalkSession {
  return { world: meta, vwgPath, buildingIndexPath: buildingIndexPath ?? '', ...(spawn ? { spawn } : {}) };
}

export interface PrepareDeps {
  /** valid id AND in the library */
  has(id: string): boolean;
  isValid(id: unknown): boolean;
  /** non-empty = a job runs or a walk is already open (reason for BUSY) */
  busyReason(): string;
  /** `inSlot` must run synchronously once the world is verified, inside the library's serial queue */
  open(id: string, inSlot: (w: { meta: WorldMeta; vwgPath: string; buildingIndexPath?: string }) => void): Promise<unknown>;
}

/** startWalk validation + session assembly. Order: id, WORLD_NOT_FOUND, BUSY, files, NO_DATA, BUSY again (state may change while awaiting). */
export async function prepareWalk(d: PrepareDeps, worldId: unknown, spawn: unknown, commit?: (s: WalkSession) => void): Promise<WalkSession> {
  if (!d.isValid(worldId)) throw new Error('BAD_REQUEST: invalid world id');
  if (!d.has(worldId as string)) throw new Error('WORLD_NOT_FOUND: world not found');
  const sp = cleanSpawn(spawn);
  const busy = (): void => {
    const r = d.busyReason();
    if (r) throw new Error(`BUSY: ${r}`);
  };
  busy();
  let out: WalkSession | null = null;
  await d.open(worldId as string, (w) => {
    if (!(w.meta.stats?.voxelCount > 0)) throw new Error('NO_DATA: this world has no voxels to walk on');
    busy(); // state may have changed while waiting for the queue
    out = buildSession(w.meta, w.vwgPath, w.buildingIndexPath, sp);
    commit?.(out); // opens the walk in the same queue slot: a queued delete/rename sees `walking` and is refused
  });
  return out!;
}
