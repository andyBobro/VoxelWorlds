import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { VwgData } from '../src/shared/vwg';
import { VoxelWorld } from '../src/renderer/preview/world';

/** n separate single-voxel columns spread over many chunks (each chunk meshes to a small cube). */
function sparse(chunks: number): VwgData {
  const x = new Int32Array(chunks), y = new Int32Array(chunks), z = new Int32Array(chunks), c = new Uint16Array(chunks).fill(1);
  for (let i = 0; i < chunks; i++) { x[i] = i * 32 + 5; y[i] = 3; z[i] = 7; }
  const header = { version: 1, voxelSize: 1, voxelCount: chunks, palette: [[0, 0, 0], [200, 100, 50]] } as unknown as VwgData['header'];
  return { header, x, y, z, c };
}

function run(w: VoxelWorld): void {
  let guard = 0;
  while (!w.done && guard++ < 10_000) w.step(50);
}

describe('VoxelWorld GPU geometry budget', () => {
  it('meshes everything without a cap', () => {
    const w = new VoxelWorld(sparse(40), new THREE.MeshBasicMaterial());
    run(w);
    expect(w.stats.truncated).toBe(false);
    expect(w.stats.chunksBuilt).toBe(40);
    expect(w.stats.geometryBytes).toBeGreaterThan(0);
    w.dispose();
  });

  it('merges chunks into super-chunks: far fewer draw calls, same triangles', () => {
    const w = new VoxelWorld(sparse(40), new THREE.MeshBasicMaterial());
    run(w);
    expect(w.groupCount).toBe(10); // 40 chunks along x, 4 per super-chunk
    expect(w.group.children.length).toBe(10);
    expect(w.stats.triangles).toBe(40 * 12); // one cube (12 tris) per chunk
    let tris = 0;
    for (const m of w.group.children as THREE.Mesh[]) tris += m.geometry.getIndex()!.count / 3;
    expect(tris).toBe(w.stats.triangles);
    w.dispose();
  });

  it('measures the byte budget on the merged geometry', () => {
    const w = new VoxelWorld(sparse(40), new THREE.MeshBasicMaterial());
    run(w);
    let actual = 0;
    for (const m of w.group.children as THREE.Mesh[]) {
      const g = m.geometry;
      actual += 4 * g.getAttribute('position').count * 3 / 3 + 4 * g.getAttribute('position').count + 4 * g.getAttribute('position').count;
      actual += g.getIndex()!.array.byteLength;
    }
    expect(w.stats.geometryBytes).toBe(actual); // 3 attributes padded to 4 B per vertex + index bytes
    w.dispose();
  });

  it('stops at the cap, reports truncation, and keeps what was built', () => {
    const full = new VoxelWorld(sparse(40), new THREE.MeshBasicMaterial());
    run(full);
    const per = full.stats.geometryBytes / 10;
    full.dispose();

    const w = new VoxelWorld(sparse(40), new THREE.MeshBasicMaterial(), true, per * 3.5);
    run(w);
    expect(w.done).toBe(true);
    expect(w.stats.truncated).toBe(true);
    expect(w.stats.chunksBuilt).toBeLessThan(40);
    expect(w.group.children.length).toBeGreaterThanOrEqual(2);
    expect(w.group.children.length).toBeLessThan(10);
    expect(w.stats.geometryBytes).toBeLessThan(per * 5);
    w.dispose();
    expect(w.group.children.length).toBe(0);
  });

  it('also stops at the triangle cap', () => {
    const w = new VoxelWorld(sparse(40), new THREE.MeshBasicMaterial(), true, Infinity, 12 * 15);
    run(w);
    expect(w.stats.truncated).toBe(true);
    expect(w.stats.triangles).toBeGreaterThanOrEqual(12 * 15);
    expect(w.stats.triangles).toBeLessThan(12 * 40);
    w.dispose();
  });

  it('keeps the super-chunks nearest the centre when truncating', () => {
    const full = new VoxelWorld(sparse(41), new THREE.MeshBasicMaterial());
    run(full);
    const per = full.stats.geometryBytes / full.groupCount;
    full.dispose();
    const w = new VoxelWorld(sparse(41), new THREE.MeshBasicMaterial(), true, per * 4);
    run(w);
    const kept = (w.group.children as THREE.Mesh[]).map((m) => Math.round((m.position.x - 5) / 128));
    const keptSet = new Set(kept);
    const total = Math.ceil(41 / 4);
    expect(kept.length).toBeLessThan(total);
    const centre = 41 / 2 / 4; // grid centre in super-chunk units
    const dist = (g: number): number => Math.abs(g * 4 + 2 - 41 / 2);
    void centre;
    const far = Math.max(...kept.map(dist));
    const missing = [...Array(total).keys()].filter((g) => !keptSet.has(g)).map(dist);
    expect(Math.min(...missing)).toBeGreaterThanOrEqual(far);
    w.dispose();
  });

  it('uploads positions as exact Uint8 chunk-local coordinates (incl. 32)', () => {
    // voxel at local x=31 -> its +x face sits on plane x=32
    const header = { version: 1, voxelSize: 1, voxelCount: 2, palette: [[0, 0, 0], [200, 100, 50]] } as unknown as VwgData['header'];
    const data: VwgData = { header, x: new Int32Array([0, 31]), y: new Int32Array([0, 0]), z: new Int32Array([0, 0]), c: new Uint16Array([1, 1]) };
    const w = new VoxelWorld(data, new THREE.MeshBasicMaterial());
    run(w);
    const g = (w.group.children[0] as THREE.Mesh).geometry;
    const pos = g.getAttribute('position');
    expect(pos.itemSize).toBe(3);
    expect(pos.array).toBeInstanceOf(Uint8Array);
    expect(pos.normalized).toBe(false);
    expect(pos.array.length).toBe(g.getAttribute('normal').array.length);
    expect(Math.max(...Array.from(pos.array))).toBe(32);
    expect(pos.getX(0)).toBe(pos.array[0]); // raw integer, not normalised (raycasting relies on this)
    w.dispose();
  });
});
