/**
 * Streams a ChunkStore into Three.js meshes around the player: time-sliced greedy meshing of 32^3 chunks, merged per
 * super-chunk (one draw call, frustum-culled by its bounding sphere), disposed again outside radius + hysteresis, with
 * the radius adapted to a triangle / GPU byte budget. The selection maths lives in streaming.ts (pure, unit-tested).
 *
 * CPU copies of uploaded geometry are released right after upload (onUpload) so memory stays bounded by the budget;
 * the price is that a lost GL context cannot re-upload, so the owner calls `resetGpu()` on loss and everything is
 * re-meshed from the store (cheap: it is the same path as normal streaming).
 */
import * as THREE from 'three';
import { geometryBytes } from '../preview/budget';
import { GROUP, boundsSphere, mergeMeshes, type MeshPart } from '../preview/merge';
import { CS, GRID_SIZE, GreedyMesher } from '../preview/mesher';
import type { ChunkStore } from './chunkStore';
import {
  ABSENT, RESIDENT, StreamPlanner, distToGroup, fogRange, nearReady, nextRadius, radiusForBudget,
  type GroupTable, type RadiusLimits,
} from './streaming';

export interface StreamerOptions {
  store: ChunkStore;
  table: GroupTable;
  material: THREE.Material;
  ao: boolean;
  limits: RadiusLimits;
  radius: number;
  /** extra metres kept resident beyond the radius before dropping (default max(0.75 span, 15% of radius)) */
  hysteresis?: number;
}

export interface StreamerStats {
  resident: number;
  triangles: number;
  geometryBytes: number;
  radius: number;
  queued: number;
  building: boolean;
  /** total ms spent meshing + merging + uploading */
  meshMs: number;
  /** longest single slice, ms (spike indicator) */
  maxSliceMs: number;
  groups: number;
}

export class GroupStreamer {
  readonly group = new THREE.Group();
  readonly state: Uint8Array;
  readonly stats: StreamerStats;
  radius: number;
  /** radius the planner last ran with (a change forces a re-plan) */
  private planRadius = -1;

  private readonly store: ChunkStore;
  private readonly table: GroupTable;
  private readonly planner: StreamPlanner;
  private readonly mesher = new GreedyMesher();
  private readonly grid = new Uint16Array(GRID_SIZE);
  private readonly meshes: Array<THREE.Mesh | null>;
  private readonly tri: Int32Array;
  private readonly byt: Float64Array;
  private readonly queue: Int32Array;
  private qLen = 0;
  private qPos = 0;
  private cur = -1;
  private curChunk = 0;
  private parts: MeshPart[] = [];
  private partBytes = 0;
  private partTris = 0;
  private lastPlan = { x: NaN, y: NaN, z: NaN, dx: 1, dz: 0, t: -1e9 };
  private lastRadiusCheck = -1e9;
  private dirty = true;

  constructor(private readonly o: StreamerOptions) {
    this.store = o.store;
    this.table = o.table;
    this.radius = o.radius;
    const n = o.table.count;
    this.state = new Uint8Array(n);
    this.meshes = new Array<THREE.Mesh | null>(n).fill(null);
    this.tri = new Int32Array(n);
    this.byt = new Float64Array(n);
    this.queue = new Int32Array(n);
    this.planner = new StreamPlanner(o.table);
    this.stats = { resident: 0, triangles: 0, geometryBytes: 0, radius: this.radius, queued: 0, building: false, meshMs: 0, maxSliceMs: 0, groups: n };
    this.group.name = 'stream';
  }

  get hysteresis(): number {
    return this.o.hysteresis ?? Math.max(this.table.span * 0.75, this.radius * 0.15);
  }

  fog(): { near: number; far: number } {
    return fogRange(this.radius);
  }

  /** Everything within `r` metres of the point is resident (or the world has nothing there). */
  ready(px: number, py: number, pz: number, r: number): { needed: number; have: number } {
    return nearReady(this.table, this.state, px, py, pz, r);
  }

  /** Force a re-selection at the next update (budget or view changed from outside). */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Advance streaming. `dirX/dirZ`: unit horizontal view direction. `sliceMs`: time this call may spend meshing.
   * Returns true while work remains (queue or a group in progress).
   */
  update(px: number, py: number, pz: number, dirX: number, dirZ: number, sliceMs: number, nowMs: number): boolean {
    const lp = this.lastPlan;
    const span = this.table.span;
    const moved = Math.hypot(px - lp.x, py - lp.y, pz - lp.z);
    const turned = lp.dx * dirX + lp.dz * dirZ < 0.9;
    if (this.dirty || !(moved < span * 0.1) || turned || this.radius !== this.planRadius || nowMs - lp.t > 1000) {
      this.replan(px, py, pz, dirX, dirZ, nowMs);
    }
    const t0 = performance.now();
    while (performance.now() - t0 < sliceMs) {
      if (this.cur < 0 && !this.startNext(px, py, pz)) break;
      this.buildSome();
    }
    const dt = performance.now() - t0;
    if (dt > this.stats.maxSliceMs) this.stats.maxSliceMs = dt;
    this.stats.meshMs += dt;
    this.stats.queued = this.qLen - this.qPos;
    this.stats.building = this.cur >= 0;
    return this.cur >= 0 || this.qPos < this.qLen;
  }

  private replan(px: number, py: number, pz: number, dirX: number, dirZ: number, nowMs: number): void {
    // 1. adapt the radius to the budget (at most every 400 ms)
    if (nowMs - this.lastRadiusCheck > 400) {
      this.lastRadiusCheck = nowMs;
      const s = this.stats;
      const over = s.triangles > this.o.limits.maxTriangles || s.geometryBytes > this.o.limits.maxBytes;
      let shrinkTo = Infinity;
      if (over) {
        const n = s.resident;
        const dist = new Float32Array(n), tris = new Float32Array(n), bytes = new Float64Array(n);
        let k = 0;
        for (let g = 0; g < this.table.count; g++) {
          if (this.state[g] !== RESIDENT || !this.meshes[g]) continue;
          dist[k] = distToGroup(this.table, g, px, py, pz); tris[k] = this.tri[g]!; bytes[k] = this.byt[g]!; k++;
        }
        shrinkTo = radiusForBudget(dist, tris, bytes, k, this.o.limits.maxTriangles, this.o.limits.maxBytes);
      }
      this.radius = nextRadius({
        ...this.o.limits, radius: this.radius, tris: s.triangles, bytes: s.geometryBytes,
        idle: this.cur < 0 && this.qPos >= this.qLen,
      }, shrinkTo);
    }
    // 2. select
    const plan = this.planner.run(this.state, px, py, pz, dirX, dirZ, this.radius, this.hysteresis);
    for (let i = 0; i < plan.unloadCount; i++) this.unloadGroup(plan.unload[i]!);
    if (this.cur >= 0 && distToGroup(this.table, this.cur, px, py, pz) > this.radius + this.hysteresis) this.abandon();
    this.queue.set(plan.load.subarray(0, plan.loadCount));
    this.qLen = plan.loadCount;
    this.qPos = 0;
    const lp = this.lastPlan;
    lp.x = px; lp.y = py; lp.z = pz; lp.dx = dirX; lp.dz = dirZ; lp.t = nowMs;
    this.planRadius = this.radius;
    this.dirty = false;
    this.stats.radius = this.radius;
  }

  private startNext(px: number, py: number, pz: number): boolean {
    while (this.qPos < this.qLen) {
      const g = this.queue[this.qPos++]!;
      if (this.state[g] !== ABSENT) continue;
      if (distToGroup(this.table, g, px, py, pz) > this.radius) continue;
      this.cur = g;
      this.curChunk = this.table.starts[g]!;
      this.parts = [];
      this.partBytes = 0;
      this.partTris = 0;
      return true;
    }
    return false;
  }

  private abandon(): void {
    this.cur = -1;
    this.parts = [];
  }

  /** Meshes one chunk of the current group; uploads the group after its last chunk. */
  private buildSome(): void {
    const g = this.cur, t = this.table;
    const id = t.order[this.curChunk]!;
    this.store.fillPadded(id, this.grid);
    const m = this.mesher.mesh(this.grid, this.store.palette, this.o.ao);
    if (m) {
      const [cx, cy, cz] = this.store.chunkCoords(id);
      this.parts.push({
        mesh: m,
        ox: (cx - t.coords[g * 3]! * GROUP) * CS,
        oy: (cy - t.coords[g * 3 + 1]! * GROUP) * CS,
        oz: (cz - t.coords[g * 3 + 2]! * GROUP) * CS,
      });
    }
    if (++this.curChunk >= t.starts[g + 1]!) this.flush(g);
  }

  private flush(g: number): void {
    const parts = this.parts;
    this.parts = [];
    this.cur = -1;
    this.state[g] = RESIDENT;
    this.stats.resident++;
    const merged = mergeMeshes(parts);
    if (!merged) return;
    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(merged.positions, 3);
    const nrm = new THREE.BufferAttribute(merged.normals, 3, true);
    const col = new THREE.BufferAttribute(merged.colors, 3, true);
    const idx = new THREE.BufferAttribute(merged.indices, 1);
    for (const a of [pos, nrm, col, idx]) a.onUpload(() => { (a as unknown as { array: unknown }).array = null; });
    geo.setAttribute('position', pos);
    geo.setAttribute('normal', nrm);
    geo.setAttribute('color', col);
    geo.setIndex(idx);
    const [sx, sy, sz, sr] = boundsSphere(merged.bounds);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(sx, sy, sz), sr + 0.5);
    const mesh = new THREE.Mesh(geo, this.o.material);
    const vs = this.store.vs, c = this.table.coords;
    mesh.position.set(
      (this.store.min[0] + c[g * 3]! * GROUP * CS) * vs,
      (this.store.min[1] + c[g * 3 + 1]! * GROUP * CS) * vs,
      (this.store.min[2] + c[g * 3 + 2]! * GROUP * CS) * vs,
    );
    mesh.scale.setScalar(vs);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.meshes[g] = mesh;
    const bytes = geometryBytes(merged.vertexCount, merged.indices.length, merged.indices instanceof Uint16Array ? 2 : 4);
    this.tri[g] = merged.triangleCount;
    this.byt[g] = bytes;
    this.stats.triangles += merged.triangleCount;
    this.stats.geometryBytes += bytes;
  }

  private unloadGroup(g: number): void {
    const m = this.meshes[g];
    if (m) {
      this.group.remove(m);
      m.geometry.dispose();
      this.meshes[g] = null;
      this.stats.triangles -= this.tri[g]!;
      this.stats.geometryBytes -= this.byt[g]!;
      this.tri[g] = 0;
      this.byt[g] = 0;
    }
    if (this.state[g] === RESIDENT) this.stats.resident--;
    this.state[g] = ABSENT;
  }

  /** Drops every GPU resource but keeps the streaming state machine usable (it re-meshes around the player). */
  resetGpu(): void {
    for (let g = 0; g < this.table.count; g++) if (this.state[g] === RESIDENT) this.unloadGroup(g);
    this.abandon();
    this.qLen = this.qPos = 0;
    this.stats.resident = 0;
    this.stats.triangles = 0;
    this.stats.geometryBytes = 0;
    this.dirty = true;
  }

  dispose(): void {
    this.resetGpu();
    this.group.clear();
  }
}
