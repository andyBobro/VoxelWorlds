import * as THREE from 'three';
import type { VwgData } from '../../shared/vwg';
import { buildChunkIndex, chunkCoords, fillChunkGrid, type ChunkIndex } from './chunking';
import { CS, GRID_SIZE, GreedyMesher, buildLinearPalette, type MeshData } from './mesher';
import { GROUP as GROUP_CHUNKS, boundsSphere, groupChunks, mergeMeshes, type ChunkGroups, type MeshPart } from './merge';
import { geometryBytes } from './budget';

export interface WorldStats {
  voxels: number;
  triangles: number;
  chunksBuilt: number;
  chunksTotal: number;
  /** cumulative meshing time (ms, chunk fill + greedy mesh, excludes upload) */
  meshMs: number;
  ao: boolean;
  /** estimated bytes of geometry uploaded to the GPU */
  geometryBytes: number;
  /** meshing stopped early at the GPU geometry budget; the outermost chunks are not shown */
  truncated: boolean;
}

/**
 * Owns the meshes of one loaded .vwg and builds them incrementally. 32^3 chunks are meshed one at a time (centre
 * outwards, a few ms per frame) but uploaded as merged GROUP^3 super-chunks: ~30-60x fewer draw calls than one mesh
 * per chunk, with frustum culling per super-chunk. A super-chunk appears once all of its chunks are meshed.
 */
export class VoxelWorld {
  readonly group = new THREE.Group();
  readonly stats: WorldStats;
  /** world-space bounds (metres) */
  readonly bounds = new THREE.Box3();
  readonly voxelSize: number;

  private data: VwgData | null;
  private index: ChunkIndex;
  private readonly groups: ChunkGroups;
  private nextGroup = 0;
  private nextInGroup = 0;
  private pending: MeshPart[] = [];
  private pendingBytes = 0;
  private readonly grid = new Uint16Array(GRID_SIZE);
  private readonly mesher = new GreedyMesher();
  private readonly palette: Uint8Array;
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(data: VwgData, private readonly material: THREE.Material, private readonly ao = true, private readonly maxGeometryBytes = Infinity, private readonly maxTriangles = Infinity) {
    this.data = data;
    this.voxelSize = data.header.voxelSize;
    this.palette = buildLinearPalette(data.header.palette);
    this.index = buildChunkIndex(data.x, data.y, data.z);
    this.groups = groupChunks(this.index.dims, this.index.chunkIds);
    const vs = this.voxelSize;
    const { min, max } = this.index;
    this.bounds.set(
      new THREE.Vector3(min[0] * vs, min[1] * vs, min[2] * vs),
      new THREE.Vector3(max[0] * vs, max[1] * vs, max[2] * vs),
    );
    this.stats = { voxels: data.x.length, triangles: 0, chunksBuilt: 0, chunksTotal: this.index.chunkIds.length, meshMs: 0, ao, geometryBytes: 0, truncated: false };
    this.group.name = 'voxel-world';
  }

  /** Number of super-chunks (draw calls at most) the whole scene will have. */
  get groupCount(): number {
    return this.groups.coords.length / 3;
  }

  get done(): boolean {
    return this.stats.truncated || this.nextGroup >= this.groupCount;
  }

  /** Mesh chunks (centre outwards) until `budgetMs` elapses. */
  step(budgetMs: number): void {
    const d = this.data;
    if (!d || this.done) return;
    const t0 = performance.now();
    const { order, starts } = this.groups;
    do {
      const g = this.nextGroup;
      const at = starts[g]! + this.nextInGroup++;
      this.buildChunk(d, order[at]!, g);
      if (at + 1 >= starts[g + 1]!) { // last chunk of the super-chunk: upload it
        this.flush(g);
        this.nextGroup++;
        this.nextInGroup = 0;
      } else if (this.overBudget(this.stats.geometryBytes + this.pendingBytes)) {
        this.flush(g); // over budget mid-group: keep what is meshed
        this.nextGroup++;
        this.nextInGroup = 0;
      }
      if (this.overBudget(this.stats.geometryBytes) && this.nextGroup < this.groupCount) this.stats.truncated = true;
    } while (!this.stats.truncated && this.nextGroup < this.groupCount && performance.now() - t0 < budgetMs);
    if (this.done) this.data = null; // release references to the source buffer
  }

  private overBudget(bytes: number): boolean {
    return bytes >= this.maxGeometryBytes || this.stats.triangles >= this.maxTriangles;
  }

  private buildChunk(d: VwgData, id: number, g: number): void {
    const t0 = performance.now();
    fillChunkGrid(this.index, d.x, d.y, d.z, d.c, id, this.grid);
    this.stats.chunksBuilt++;
    const m: MeshData | null = this.mesher.mesh(this.grid, this.palette, this.ao);
    this.stats.meshMs += performance.now() - t0;
    if (!m) return;
    const [cx, cy, cz] = chunkCoords(this.index, id);
    const { coords } = this.groups;
    this.pending.push({
      mesh: m,
      ox: (cx - coords[g * 3]! * GROUP_CHUNKS) * CS,
      oy: (cy - coords[g * 3 + 1]! * GROUP_CHUNKS) * CS,
      oz: (cz - coords[g * 3 + 2]! * GROUP_CHUNKS) * CS,
    });
    this.pendingBytes += geometryBytes(m.vertexCount, m.indices.length, 4);
    this.stats.triangles += m.triangleCount;
  }

  /** Merge the pending chunk meshes of super-chunk `g` into one mesh and add it to the scene. */
  private flush(g: number): void {
    const parts = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    const m = mergeMeshes(parts);
    if (!m) return;
    const geo = new THREE.BufferGeometry();
    // Super-chunk-local corners are integers 0..128, so 1 byte per axis is exact (vs 12 bytes as float32).
    geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3, true));
    geo.setAttribute('color', new THREE.BufferAttribute(m.colors, 3, true));
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const [sx, sy, sz, sr] = boundsSphere(m.bounds);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(sx, sy, sz), sr + 0.5);

    const mesh = new THREE.Mesh(geo, this.material);
    const { coords } = this.groups;
    const vs = this.voxelSize;
    mesh.position.set(
      (this.index.min[0] + coords[g * 3]! * GROUP_CHUNKS * CS) * vs,
      (this.index.min[1] + coords[g * 3 + 1]! * GROUP_CHUNKS * CS) * vs,
      (this.index.min[2] + coords[g * 3 + 2]! * GROUP_CHUNKS * CS) * vs,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.scale.setScalar(vs);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.geometries.push(geo);
    this.stats.geometryBytes += geometryBytes(m.vertexCount, m.indices.length, m.indices instanceof Uint16Array ? 2 : 4);
  }

  /** Disposes geometries only; the shared material is owned by the caller. */
  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.pending = [];
    this.group.clear();
    this.data = null;
  }
}
