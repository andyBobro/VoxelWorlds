/**
 * Owns the WebGL renderer of the walking window: creation with the preview's retry ladder (cheaper options after each
 * failure, waiting between attempts so a stressed GPU process can free memory), resize + devicePixelRatio cap, and
 * context-loss handling (preventDefault so the browser may restore it; if it does not come back within a grace period
 * the host asks its owner to remount at a lower budget).
 */
import * as THREE from 'three';
import { rendererAttempts, type RenderBudget, type RendererOptions } from '../preview/budget';

const wait = (ms: number): Promise<void> => new Promise((res) => { setTimeout(() => requestAnimationFrame(() => res()), ms); });

function tryCreate(o: RendererOptions): THREE.WebGLRenderer {
  const r = new THREE.WebGLRenderer({ antialias: o.antialias, alpha: o.alpha, powerPreference: o.powerPreference, stencil: o.stencil });
  r.setPixelRatio(o.pixelRatio);
  return r;
}

export async function createRendererRetry(budget: RenderBudget): Promise<{ renderer: THREE.WebGLRenderer; opts: RendererOptions }> {
  const attempts = rendererAttempts(budget, window.devicePixelRatio || 1);
  let last: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      return { renderer: tryCreate(attempts[i]!), opts: attempts[i]! };
    } catch (e) {
      last = e;
      console.warn(`WebGL context creation failed (attempt ${i + 1}/${attempts.length}): ${String((e as Error)?.message ?? e)}`);
      await wait(150 * (i + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export class GlHost {
  renderer!: THREE.WebGLRenderer;
  opts!: RendererOptions;
  /** true between webglcontextlost and webglcontextrestored */
  lost = false;
  /** GPU contents are gone (context lost, or a new renderer): owners must drop their GPU resources */
  onGpuReset: (() => void) | null = null;
  /** the context did not come back within the grace period: owner should call remount(degrade) */
  onGone: (() => void) | null = null;

  private lostTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly ro: ResizeObserver;
  private cleanup: Array<() => void> = [];

  private constructor(private readonly container: HTMLElement) {
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
  }

  static async create(container: HTMLElement, budget: RenderBudget): Promise<GlHost> {
    const h = new GlHost(container);
    await h.attach(budget);
    return h;
  }

  private async attach(budget: RenderBudget): Promise<void> {
    const { renderer, opts } = await createRendererRetry(budget);
    this.renderer = renderer;
    this.opts = opts;
    renderer.setClearColor(0x000000, 0); // the sky is the container's CSS gradient: cannot go black with GL state
    renderer.shadowMap.enabled = false;
    const canvas = renderer.domElement;
    canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;';
    canvas.tabIndex = 0;
    this.container.appendChild(canvas);
    const onLost = (e: Event): void => {
      e.preventDefault();
      this.lost = true;
      this.onGpuReset?.();
      if (this.lostTimer || this.disposed) return;
      this.lostTimer = setTimeout(() => {
        this.lostTimer = null;
        if (!this.disposed && this.lost) this.onGone?.();
      }, 1500);
    };
    const onRestored = (): void => {
      this.lost = false;
      if (this.lostTimer) { clearTimeout(this.lostTimer); this.lostTimer = null; }
      this.onGpuReset?.();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    this.cleanup.push(() => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    });
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  resize(): void {
    if (this.disposed || !this.renderer) return;
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.onResize?.(w, h);
  }
  onResize: ((w: number, h: number) => void) | null = null;

  private teardownRenderer(): void {
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
    const r = this.renderer;
    r.setAnimationLoop(null);
    r.renderLists.dispose();
    r.dispose();
    r.forceContextLoss(); // release the GL context now, not at GC time
    const c = r.domElement;
    c.width = c.height = 1;
    c.remove();
  }

  /** Replaces the renderer by a new one created from `budget` (callers rebuild their GPU resources in onGpuReset). */
  async remount(budget: RenderBudget): Promise<void> {
    if (this.lostTimer) { clearTimeout(this.lostTimer); this.lostTimer = null; }
    this.teardownRenderer();
    this.lost = false;
    await this.attach(budget);
    this.onGpuReset?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.lostTimer) clearTimeout(this.lostTimer);
    this.ro.disconnect();
    this.teardownRenderer();
  }
}
