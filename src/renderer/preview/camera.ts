import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type CameraMode = 'orbit' | 'fly';

const isEditable = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export interface CameraState {
  pos: THREE.Vector3; quat: THREE.Quaternion; target: THREE.Vector3; orbitDist: number;
  baseSpeed: number; speedMul: number; mode: CameraMode; minD: number; maxD: number; near: number; far: number;
}

/** Orbit (macro) + pointer-lock fly (first person) with position preserved on switch. */
export class CameraRig {
  mode: CameraMode = 'orbit';
  locked = false;
  /** True after pointerlockerror: drag-to-look fallback is active. */
  lockFailed = false;
  private dragging = false;
  readonly orbit: OrbitControls;
  /** Fired after any mode / pointer-lock change. */
  onModeChange: (() => void) | null = null;

  private readonly keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private baseSpeed = 20; // m/s
  private speedMul = 1;
  private orbitDist = 100;
  private hovered = false;
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly move = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly off: Array<() => void> = [];

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLCanvasElement,
    private readonly onChange: () => void,
  ) {
    camera.rotation.order = 'YXZ';
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.1;
    this.orbit.screenSpacePanning = true;

    const on = <K extends keyof WindowEventMap>(t: Window, k: K, f: (e: WindowEventMap[K]) => void) => {
      t.addEventListener(k, f as EventListener);
      this.off.push(() => t.removeEventListener(k, f as EventListener));
    };
    const onEl = (t: EventTarget, k: string, f: (e: any) => void, o?: AddEventListenerOptions) => {
      t.addEventListener(k, f, o);
      this.off.push(() => t.removeEventListener(k, f, o));
    };

    on(window, 'keydown', (e) => {
      if (isEditable(e.target)) return;
      if (e.code === 'Tab') {
        if (this.hovered || this.locked || e.target === document.body) {
          e.preventDefault();
          if (!e.repeat) this.setMode(this.mode === 'orbit' ? 'fly' : 'orbit');
        }
        return;
      }
      if (this.mode === 'fly') {
        this.keys.add(e.code);
        if (e.code.startsWith('Key') || e.code.startsWith('Shift')) e.preventDefault();
      }
    });
    on(window, 'keyup', (e) => this.keys.delete(e.code));
    on(window, 'blur', () => {
      this.keys.clear();
      this.dragging = false;
      this.releaseLock();
    });
    onEl(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (this.locked) this.lockFailed = false;
      else this.keys.clear();
      this.dragging = false;
      this.onChange();
      this.onModeChange?.();
    });
    onEl(document, 'pointerlockerror', () => {
      this.locked = false;
      this.lockFailed = true;
      this.onChange();
    });
    onEl(document, 'mousemove', (e: MouseEvent) => {
      if (this.mode !== 'fly' || !(this.locked || this.dragging)) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * 0.0022));
    });
    onEl(dom, 'mousedown', (e: MouseEvent) => {
      if (this.mode === 'fly' && this.lockFailed && !this.locked && e.button === 0) this.dragging = true;
    });
    onEl(window, 'mouseup', () => (this.dragging = false));
    onEl(dom, 'click', () => {
      if (this.mode === 'fly' && !this.locked && !this.lockFailed) this.requestLock();
    });
    onEl(dom, 'pointerenter', () => (this.hovered = true));
    onEl(dom, 'pointerleave', () => (this.hovered = false));
    onEl(
      dom,
      'wheel',
      (e: WheelEvent) => {
        if (this.mode !== 'fly') return;
        e.preventDefault();
        this.speedMul = Math.max(0.1, Math.min(20, this.speedMul * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      },
      { passive: false },
    );
  }

  /** Place camera to see a bounding sphere and size speeds from it. */
  frame(center: THREE.Vector3, radius: number, voxelSize: number): void {
    const dist = Math.max(radius, voxelSize * 4) * 2.2;
    this.camera.position.set(center.x + dist * 0.55, center.y + dist * 0.6, center.z + dist * 0.75);
    this.orbit.target.copy(center);
    this.orbitDist = this.camera.position.distanceTo(center);
    this.orbit.minDistance = voxelSize * 2;
    this.orbit.maxDistance = Math.max(radius, voxelSize) * 12;
    // Cross the full extent (2*radius) in ~25 s at base speed, clamped to a sane range.
    this.baseSpeed = Math.max(3, Math.min(40, (radius * 2) / 25));
    this.speedMul = 1;
    this.camera.lookAt(center);
    this.orbit.update();
    if (this.mode === 'fly') this.syncAnglesFromCamera();
  }

  /** Re-target the orbit camera on a point and zoom to `radius`, keeping the current viewing direction and limits. */
  focus(center: THREE.Vector3, radius: number): void {
    if (this.mode === 'fly') this.setMode('orbit');
    const dir = this.camera.position.clone().sub(this.orbit.target);
    if (dir.lengthSq() < 1e-9) dir.set(0.55, 0.6, 0.75);
    dir.normalize();
    // keep a downward view so the building is not hidden behind neighbours
    if (dir.y < 0.35) { dir.y = 0.35; dir.normalize(); }
    const dist = Math.min(Math.max(radius * 4.5, this.orbit.minDistance), Math.max(this.orbit.maxDistance, radius * 5));
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.orbitDist = dist;
    this.camera.lookAt(center);
    this.orbit.update();
  }

  /** Snapshot for returning from a detail scene. */
  saveState(): CameraState {
    return {
      pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), target: this.orbit.target.clone(),
      orbitDist: this.orbitDist, baseSpeed: this.baseSpeed, speedMul: this.speedMul, mode: this.mode,
      minD: this.orbit.minDistance, maxD: this.orbit.maxDistance, near: this.camera.near, far: this.camera.far,
    };
  }

  restoreState(s: CameraState): void {
    if (this.mode === 'fly') this.setMode('orbit');
    this.camera.position.copy(s.pos);
    this.camera.quaternion.copy(s.quat);
    this.orbit.target.copy(s.target);
    this.orbit.minDistance = s.minD;
    this.orbit.maxDistance = s.maxD;
    this.orbitDist = s.orbitDist;
    this.baseSpeed = s.baseSpeed;
    this.speedMul = s.speedMul;
    this.camera.near = s.near;
    this.camera.far = s.far;
    this.camera.updateProjectionMatrix();
    this.orbit.update();
    if (s.mode === 'fly') this.setMode('fly');
  }

  setMode(m: CameraMode): void {
    if (m === this.mode) return;
    if (m === 'fly') {
      this.orbitDist = this.camera.position.distanceTo(this.orbit.target);
      this.orbit.enabled = false;
      this.mode = 'fly';
      this.syncAnglesFromCamera();
      this.lockFailed = false;
      this.requestLock();
    } else {
      this.releaseLock();
      this.keys.clear();
      this.camera.getWorldDirection(this.fwd);
      this.orbit.target.copy(this.camera.position).addScaledVector(this.fwd, this.orbitDist);
      this.mode = 'orbit';
      this.lockFailed = false;
      this.dragging = false;
      this.orbit.enabled = true;
      this.orbit.update();
    }
    this.onChange();
    this.onModeChange?.();
  }

  get speed(): number {
    return this.baseSpeed * this.speedMul;
  }

  update(dt: number): void {
    if (this.mode === 'orbit') {
      this.orbit.update();
      return;
    }
    this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this.euler);
    const k = this.keys;
    const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const r = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const u = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    if (!f && !r && !u) return;
    this.camera.getWorldDirection(this.fwd);
    this.right.crossVectors(this.fwd, this.camera.up).normalize();
    this.move.set(0, 0, 0).addScaledVector(this.fwd, f).addScaledVector(this.right, r);
    this.move.y += u;
    if (this.move.lengthSq() === 0) return;
    const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1;
    this.move.normalize().multiplyScalar(this.speed * boost * Math.min(dt, 0.1));
    this.camera.position.add(this.move);
  }

  dispose(): void {
    this.releaseLock();
    this.off.forEach((f) => f());
    this.off.length = 0;
    this.orbit.dispose();
  }

  private syncAnglesFromCamera(): void {
    this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = this.euler.y;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.euler.x));
  }

  private requestLock(): void {
    try {
      const p = this.dom.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => undefined);
    } catch {
      /* needs a user gesture; the next click retries */
    }
  }

  private releaseLock(): void {
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }
}
