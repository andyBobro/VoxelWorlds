import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DegradeTracker } from '../src/renderer/preview/budget';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ voxels?: number; degrade?: number }>,
  handles: [] as Array<{ disposed: boolean; onContextLost: (() => void) | null }>,
  gate: null as null | Promise<void>,
  failNext: false,
}));

vi.mock('../src/renderer/preview', () => ({
  mountPreviewAsync: async (_c: unknown, opts: { voxels?: number; degrade?: number }) => {
    state.calls.push({ ...opts });
    if (state.gate) await state.gate;
    if (state.failNext) { state.failNext = false; throw new Error('THREE.WebGLRenderer: Error creating WebGL context.'); }
    const h = {
      disposed: false, onContextLost: null as (() => void) | null, onPick: null,
      load() {}, dispose() { h.disposed = true; }, setMarkers() {}, setMarkersVisible() {}, setHighlight() {},
      getAmbientOcclusion: () => ({ on: false, available: false }), setAmbientOcclusion: () => false,
    };
    state.handles.push(h);
    return h;
  },
}));

import { PreviewHost } from '../src/renderer/ui/previewHost';

/** Minimal .vwg buffer: only the header is read by the host (peekVoxelCount). */
function vwg(voxels: number): ArrayBuffer {
  const h = new TextEncoder().encode(JSON.stringify({ version: 1, voxelCount: voxels }));
  const b = new ArrayBuffer(8 + h.length);
  new DataView(b).setUint32(4, h.length, true);
  new Uint8Array(b, 8).set(h);
  return b;
}

const container = { querySelector: () => null } as unknown as HTMLElement;

describe('PreviewHost degrade + epoch', () => {
  beforeEach(() => {
    state.calls.length = 0; state.handles.length = 0; state.gate = null; state.failNext = false;
    (globalThis as { document?: unknown }).document = { addEventListener() {} };
  });
  afterEach(() => { delete (globalThis as { document?: unknown }).document; });

  it('a context loss raises degrade once and the remount (even of a small scene) keeps it', async () => {
    const host = new PreviewHost(container);
    let lost = 0;
    host.onContextLost = () => { lost++; };
    expect(await host.load(vwg(1000))).toBe(true);
    expect(state.calls[0]!.degrade).toBe(0);
    state.handles[0]!.onContextLost!();
    expect(lost).toBe(1);
    expect(host.degradeLevel).toBe(1);
    host.dispose();
    await host.load(vwg(1000)); // the owner's remount
    expect(state.calls[1]!.degrade).toBe(1);
  });

  it('a failed mount right after a loss is the same incident (no double bump)', async () => {
    const host = new PreviewHost(container);
    await host.load(vwg(1000));
    state.handles[0]!.onContextLost!();
    host.dispose();
    state.failNext = true;
    await expect(host.load(vwg(1000))).rejects.toThrow(/WebGL/);
    expect(host.degradeLevel).toBe(1);
  });

  it('a failed mount alone raises degrade for the next Reload; resetDegrade clears it', async () => {
    const host = new PreviewHost(container);
    state.failNext = true;
    await expect(host.load(vwg(1000))).rejects.toThrow();
    expect(host.degradeLevel).toBe(1);
    await host.load(vwg(1000));
    expect(state.calls[1]!.degrade).toBe(1);
    host.resetDegrade();
    host.dispose();
    await host.load(vwg(1000));
    expect(state.calls[2]!.degrade).toBe(0);
  });

  it('dispose() during an in-flight mount releases the new handle and resolves false', async () => {
    const host = new PreviewHost(container);
    let open!: () => void;
    state.gate = new Promise<void>((r) => { open = r; });
    const p = host.load(vwg(1000));
    await new Promise((r) => setTimeout(r, 0));
    host.dispose(); // e.g. the world was deleted while the context was being created
    open();
    expect(await p).toBe(false);
    expect(state.handles).toHaveLength(1);
    expect(state.handles[0]!.disposed).toBe(true);
    expect(host.voxelSize).toBe(0);
  });

  it('ignores context loss from a handle that was already replaced', async () => {
    const host = new PreviewHost(container);
    let lost = 0;
    host.onContextLost = () => { lost++; };
    await host.load(vwg(1000));
    const old = state.handles[0]!;
    host.dispose();
    await host.load(vwg(1000));
    old.onContextLost?.();
    expect(lost).toBe(0);
    expect(host.degradeLevel).toBe(0);
  });

  it('degrade tracker constants are sane', () => {
    expect(DegradeTracker.MAX).toBeGreaterThan(0);
  });
});
