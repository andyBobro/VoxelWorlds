import * as THREE from 'three';
import type { VwgData } from '../../shared/vwg';
import { buildChunkIndex, chunkCoords, fillChunkGrid, type ChunkIndex } from './chunking';
import { CS, GRID_SIZE, GreedyMesher, buildLinearPalette } from './mesher';

export interface WorldStats {
  voxels: number;
  triangles: number;
  chunksBuilt: number;
  chunksTotal: number;
  /** cumulative meshing time (ms, chunk fill + greedy mesh, excludes upload) */
  meshMs: number;
  ao: boolean;
}

/** Owns the chunk meshes of one loaded .vwg and builds them incrementally. */
export class VoxelWorld {
  readonly group = new THREE.Group();
  readonly stats: WorldStats;
  /** world-space bounds (metres) */
  readonly bounds = new THREE.Box3();
  readonly voxelSize: number;

  private data: VwgData | null;
  private index: ChunkIndex;
  private next = 0;
  private readonly grid = new Uint16Array(GRID_SIZE);
  private readonly mesher = new GreedyMesher();
  private readonly palette: Uint8Array;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(CS / 2, CS / 2, CS / 2), CS * 0.8661);

  constructor(data: VwgData, private readonly material: THREE.Material, private readonly ao = true) {
    this.data = data;
    this.voxelSize = data.header.voxelSize;
    this.palette = buildLinearPalette(data.header.palette);
    this.index = buildChunkIndex(data.x, data.y, data.z);
    const vs = this.voxelSize;
    const { min, max } = this.index;
    this.bounds.set(
      new THREE.Vector3(min[0] * vs, min[1] * vs, min[2] * vs),
      new THREE.Vector3(max[0] * vs, max[1] * vs, max[2] * vs),
    );
    this.stats = { voxels: data.x.length, triangles: 0, chunksBuilt: 0, chunksTotal: this.index.chunkIds.length, meshMs: 0, ao };
    this.group.name = 'voxel-world';
  }

  get done(): boolean {
    return this.next >= this.index.chunkIds.length;
  }

  /** Mesh chunks (centre outwards) until `budgetMs` elapses. */
  step(budgetMs: number): void {
    const d = this.data;
    if (!d || this.done) return;
    const t0 = performance.now();
    const ids = this.index.chunkIds;
    do {
      this.buildChunk(d, ids[this.next++]!);
    } while (this.next < ids.length && performance.now() - t0 < budgetMs);
    if (this.done) this.data = null; // release references to the source buffer
  }

  private buildChunk(d: VwgData, id: number): void {
    const t0 = performance.now();
    fillChunkGrid(this.index, d.x, d.y, d.z, d.c, id, this.grid);
    this.stats.chunksBuilt++;
    const m = this.mesher.mesh(this.grid, this.palette, this.ao);
    this.stats.meshMs += performance.now() - t0;
    if (!m) return;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3, true));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    g.boundingSphere = this.sphere.clone();

    const mesh = new THREE.Mesh(g, this.material);
    const [cx, cy, cz] = chunkCoords(this.index, id);
    const vs = this.voxelSize;
    mesh.position.set(
      (this.index.min[0] + cx * CS) * vs,
      (this.index.min[1] + cy * CS) * vs,
      (this.index.min[2] + cz * CS) * vs,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.scale.setScalar(vs);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.geometries.push(g);
    this.stats.triangles += m.triangleCount;
  }

  /** Disposes geometries only; the shared material is owned by the caller. */
  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.group.clear();
    this.data = null;
  }
}
