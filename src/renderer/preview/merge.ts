/**
 * Pure helpers that turn many 32^3 chunk meshes into few "super-chunk" meshes (fewer draw calls, per-super frustum
 * culling). No Three.js dependency.
 */
import { CS } from './mesher';
import type { MeshData } from './mesher';

/** Chunks per super-chunk edge. 4 * CS = 128 keeps every local coordinate (0..128) inside a Uint8. */
export const GROUP = 4;

export interface ChunkGroups {
  /** chunk ids, grouped; groups ordered nearest-the-centre first */
  order: Uint32Array;
  /** group g owns order[starts[g] .. starts[g+1]) */
  starts: Int32Array;
  /** super-chunk coordinates (gx, gy, gz) per group, 3 ints each */
  coords: Int32Array;
}

/**
 * Buckets non-empty chunk ids (id = (cy*dz + cz)*dx + cx) into GROUP^3 super-chunks aligned to the chunk grid and
 * orders the groups by distance of their centre from the centre of the grid (same weighting as the chunk order:
 * vertical distance counts double, so ground-level scenes load outwards from the middle).
 */
export function groupChunks(dims: readonly [number, number, number], chunkIds: ArrayLike<number>, group = GROUP): ChunkGroups {
  const [dx, dy, dz] = dims;
  const gdx = Math.ceil(dx / group), gdz = Math.ceil(dz / group);
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < chunkIds.length; i++) {
    const id = chunkIds[i]!;
    const cx = id % dx, cz = Math.floor(id / dx) % dz, cy = Math.floor(id / (dx * dz));
    const key = ((Math.floor(cy / group)) * gdz + Math.floor(cz / group)) * gdx + Math.floor(cx / group);
    const b = buckets.get(key);
    if (b) b.push(id); else buckets.set(key, [id]);
  }
  const keys = [...buckets.keys()];
  const dist = (key: number): number => {
    const gx = key % gdx, gz = Math.floor(key / gdx) % gdz, gy = Math.floor(key / (gdx * gdz));
    // group centre in chunk units, relative to the grid centre
    const ex = gx * group + group / 2 - dx / 2, ey = gy * group + group / 2 - dy / 2, ez = gz * group + group / 2 - dz / 2;
    return ex * ex + ey * ey * 4 + ez * ez;
  };
  const d = new Map(keys.map((k) => [k, dist(k)] as const));
  keys.sort((a, b) => d.get(a)! - d.get(b)! || a - b);
  const order = new Uint32Array(chunkIds.length);
  const starts = new Int32Array(keys.length + 1);
  const coords = new Int32Array(keys.length * 3);
  let n = 0;
  keys.forEach((key, g) => {
    starts[g] = n;
    coords[g * 3] = key % gdx;
    coords[g * 3 + 1] = Math.floor(key / (gdx * gdz));
    coords[g * 3 + 2] = Math.floor(key / gdx) % gdz;
    const ids = buckets.get(key)!.sort((a, b) => a - b);
    for (const id of ids) order[n++] = id;
  });
  starts[keys.length] = n;
  return { order, starts, coords };
}

export interface MeshPart {
  mesh: MeshData;
  /** chunk origin inside the super-chunk, in voxels (multiples of CS, 0..(GROUP-1)*CS) */
  ox: number; oy: number; oz: number;
}

export interface MergedMesh {
  positions: Uint8Array; // super-chunk-local, voxel units (0..GROUP*CS)
  normals: Int8Array;
  colors: Uint8Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  triangleCount: number;
  /** exact local bounds of all vertices: [x0,y0,z0,x1,y1,z1] */
  bounds: [number, number, number, number, number, number];
}

/** Concatenates chunk meshes into one mesh (offsetting positions and indices). Returns null for no parts. */
export function mergeMeshes(parts: readonly MeshPart[]): MergedMesh | null {
  let vc = 0, ic = 0;
  for (const p of parts) { vc += p.mesh.vertexCount; ic += p.mesh.indices.length; }
  if (vc === 0) return null;
  const positions = new Uint8Array(vc * 3);
  const normals = new Int8Array(vc * 3);
  const colors = new Uint8Array(vc * 3);
  const indices = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  const b: MergedMesh['bounds'] = [255, 255, 255, 0, 0, 0];
  let vo = 0, io = 0;
  for (const p of parts) {
    const m = p.mesh;
    const src = m.positions;
    const base = vo * 3;
    for (let i = 0; i < m.vertexCount; i++) {
      const o = i * 3;
      const x = src[o]! + p.ox, y = src[o + 1]! + p.oy, z = src[o + 2]! + p.oz;
      positions[base + o] = x; positions[base + o + 1] = y; positions[base + o + 2] = z;
      if (x < b[0]) b[0] = x; if (x > b[3]) b[3] = x;
      if (y < b[1]) b[1] = y; if (y > b[4]) b[4] = y;
      if (z < b[2]) b[2] = z; if (z > b[5]) b[5] = z;
    }
    normals.set(m.normals.subarray(0, m.vertexCount * 3), base);
    colors.set(m.colors.subarray(0, m.vertexCount * 3), base);
    const idx = m.indices;
    for (let i = 0; i < idx.length; i++) indices[io + i] = idx[i]! + vo;
    vo += m.vertexCount;
    io += idx.length;
  }
  return { positions, normals, colors, indices, vertexCount: vc, triangleCount: ic / 3, bounds: b };
}

/** Sphere (centre xyz + radius) enclosing a bounds box; used as the frustum-culling volume of a super-chunk. */
export function boundsSphere(b: readonly number[]): [number, number, number, number] {
  const cx = (b[0]! + b[3]!) / 2, cy = (b[1]! + b[4]!) / 2, cz = (b[2]! + b[5]!) / 2;
  const r = Math.hypot(b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!) / 2;
  return [cx, cy, cz, r];
}

export const SUPER_SPAN = GROUP * CS;
