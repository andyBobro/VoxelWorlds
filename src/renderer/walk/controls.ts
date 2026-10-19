/**
 * First-person input: WASD / arrows, Shift run, Space jump, E interact, mouse look via pointer lock with a drag-look
 * fallback (when capture is refused, e.g. automation or some window managers), wheel = walking speed.
 */
export interface LookState { yaw: number; pitch: number }

const LOOK = 0.0022;
const PITCH_MAX = 1.5;

export class Controls {
  yaw = 0;
  pitch = 0;
  locked = false;
  /** pointer capture refused: dragging with the left mouse button looks around instead */
  lockFailed = false;
  /** walking speed multiplier (wheel) */
  speedMul = 1;
  /** set by pointer lock loss / Escape while playing; the game turns it into the pause menu */
  onPauseRequest: (() => void) | null = null;
  /** pointer capture was refused for good (drag-look is active) */
  onLockFailed: (() => void) | null = null;
  /** E pressed (edge) */
  interact = false;
  private readonly keys = new Set<string>();
  private dragging = false;
  private jumpQueued = false;
  private lastUnlock = 0;
  private silentUnlock = false;
  private lockRetry: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private readonly off: Array<() => void> = [];

  constructor(private readonly dom: HTMLElement) {
    const on = (t: EventTarget, k: string, f: (e: any) => void, o?: AddEventListenerOptions): void => {
      t.addEventListener(k, f, o);
      this.off.push(() => t.removeEventListener(k, f, o));
    };
    on(window, 'keydown', (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Escape') {
        // with a locked pointer the browser eats Escape (pointerlockchange follows); this path is for the fallback mode
        // (the game decides by state: pause while playing, resume while paused, nothing during loading/transitions)
        if (!e.repeat && performance.now() - this.lastUnlock > 120) this.onPauseRequest?.();
        return;
      }
      if (!this.enabled) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault();
      if (e.code === 'Space' && !e.repeat) this.jumpQueued = true;
      if (e.code === 'KeyE' && !e.repeat) this.interact = true;
      this.keys.add(e.code);
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    on(window, 'blur', () => { this.keys.clear(); this.dragging = false; });
    on(document, 'pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === this.dom;
      if (this.locked) this.lockFailed = false;
      else { this.keys.clear(); this.dragging = false; }
      if (was && !this.locked) {
        this.lastUnlock = performance.now();
        // our own releaseLock() (transitions, menus) must not pop the pause menu when its event arrives late
        if (this.silentUnlock) this.silentUnlock = false;
        else if (this.enabled) this.onPauseRequest?.();
      }
    });
    on(document, 'pointerlockerror', () => {
      this.locked = false;
      // Chrome refuses a lock requested within ~1.3 s of an Escape unlock: retry once before falling back to drag-look
      if (!this.lockRetry && performance.now() - this.lastUnlock < 1500) {
        this.lockRetry = setTimeout(() => { this.lockRetry = null; this.requestLock(); }, 1400);
      } else {
        const first = !this.lockFailed;
        this.lockFailed = true;
        if (first) this.onLockFailed?.();
      }
    });
    on(document, 'mousemove', (e: MouseEvent) => {
      if (!this.enabled || !(this.locked || this.dragging)) return;
      this.yaw -= e.movementX * LOOK;
      this.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, this.pitch - e.movementY * LOOK));
    });
    on(dom, 'mousedown', (e: MouseEvent) => {
      if (this.enabled && this.lockFailed && !this.locked && e.button === 0) this.dragging = true;
    });
    on(window, 'mouseup', () => { this.dragging = false; });
    on(dom, 'click', () => {
      if (this.enabled && !this.locked && !this.lockFailed) this.requestLock();
    });
    on(dom, 'wheel', (e: WheelEvent) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.speedMul = Math.max(0.25, Math.min(8, this.speedMul * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    }, { passive: false });
  }

  /** Input is ignored while disabled (menus, loading, transitions). */
  setEnabled(v: boolean): void {
    this.enabled = v;
    if (!v) { this.keys.clear(); this.dragging = false; this.jumpQueued = false; this.interact = false; }
  }

  requestLock(): void {
    try {
      const p = this.dom.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => undefined);
    } catch {
      /* needs a user gesture; the next click retries */
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement === this.dom) {
      this.silentUnlock = true;
      document.exitPointerLock();
    }
  }

  has(code: string): boolean {
    return this.keys.has(code);
  }

  /** Space is edge-triggered but holding it keeps jumping on landing. */
  consumeJump(): boolean {
    const j = this.jumpQueued || this.keys.has('Space');
    this.jumpQueued = false;
    return j;
  }

  consumeInteract(): boolean {
    const i = this.interact;
    this.interact = false;
    return i;
  }

  /** Horizontal wish direction in world XZ (unit length at most) for the current yaw. */
  wish(out: { x: number; z: number }): void {
    const f = (this.has('KeyW') || this.has('ArrowUp') ? 1 : 0) - (this.has('KeyS') || this.has('ArrowDown') ? 1 : 0);
    const r = (this.has('KeyD') || this.has('ArrowRight') ? 1 : 0) - (this.has('KeyA') || this.has('ArrowLeft') ? 1 : 0);
    const l = Math.hypot(f, r);
    if (l === 0) { out.x = out.z = 0; return; }
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    // forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw)
    out.x = (-s * f + c * r) / l;
    out.z = (-c * f - s * r) / l;
  }

  get run(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  dispose(): void {
    if (this.lockRetry) clearTimeout(this.lockRetry);
    this.releaseLock();
    this.off.forEach((f) => f());
    this.off.length = 0;
  }
}
