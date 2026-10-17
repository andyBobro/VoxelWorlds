/**
 * Pure greedy mesher. No Three.js dependency: takes a padded dense chunk grid
 * and returns typed arrays ready to become a BufferGeometry.
 *
 * Grid layout: (CS+2)^3 Uint16 palette indices (0 = air) with a 1-voxel border
 * holding neighbour-chunk voxels so faces on chunk edges are culled correctly.
 * Index = (x+1) + (z+1)*P + (y+1)*P*P.
 */
export const CS = 32;
export const P = CS + 2;
export const GRID_SIZE = P * P * P;

export interface MeshData {
  positions: Float32Array; // chunk-local, in voxel units
  normals: Int8Array; // normalized on upload
  colors: Uint8Array; // linear RGB, normalized on upload
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

const STRIDE = [1, P * P, P]; // per axis x, y, z
const ORIGIN = 1 + P + P * P;
const CU_P = [0, 1, 1, 0];
const CV_P = [0, 0, 1, 1];
const CU_N = [0, 0, 1, 1];
const CV_N = [0, 1, 1, 0];

/** Brightness per AO occlusion level (0 = fully lit, 3 = deepest corner). */
const AO_LEVEL = [1, 0.74, 0.54, 0.38];

/**
 * Per-corner ambient occlusion of the face whose outward neighbour voxel is `n`, packed 2 bits per geometric
 * corner (slot 0..3 = (-,-),(+,-),(+,+),(-,+) in u,v). 0 for all corners = unoccluded.
 */
function aoKey(grid: Uint16Array, n: number, su: number, sv: number): number {
  const sm = grid[n - su]! !== 0 ? 1 : 0, sp = grid[n + su]! !== 0 ? 1 : 0;
  const tm = grid[n - sv]! !== 0 ? 1 : 0, tp = grid[n + sv]! !== 0 ? 1 : 0;
  const mm = grid[n - su - sv]! !== 0 ? 1 : 0, pm = grid[n + su - sv]! !== 0 ? 1 : 0;
  const pp = grid[n + su + sv]! !== 0 ? 1 : 0, mp = grid[n - su + sv]! !== 0 ? 1 : 0;
  if (!(sm | sp | tm | tp | mm | pm | pp | mp)) return 0;
  const lv = (s1: number, s2: number, c: number): number => (s1 && s2 ? 3 : s1 + s2 + c);
  // corner order (u,v): (-,-), (+,-), (+,+), (-,+)
  return lv(sm, tm, mm) | (lv(sp, tm, pm) << 2) | (lv(sp, tp, pp) << 4) | (lv(sm, tp, mp) << 6);
}

export class GreedyMesher {
  private cap = 4096; // vertices
  private pos = new Float32Array(this.cap * 3);
  private nrm = new Int8Array(this.cap * 3);
  private col = new Uint8Array(this.cap * 3);
  private idx = new Uint32Array((this.cap / 4) * 6);
  private vc = 0;
  private ic = 0;
  private readonly mask = new Uint32Array(CS * CS); // palette index | (ambient-occlusion key << 16)

  /** `palette`: linear RGB bytes, 3 per entry. Returns null for an empty mesh. */
  mesh(grid: Uint16Array, palette: Uint8Array, ao = true): MeshData | null {
    this.vc = 0;
    this.ic = 0;
    const mask = this.mask;
    const rgbN = palette.length / 3;

    for (let d = 0; d < 3; d++) {
      const u = (d + 1) % 3;
      const v = (d + 2) % 3;
      const sd = STRIDE[d]!;
      const su = STRIDE[u]!;
      const sv = STRIDE[v]!;
      for (let dir = -1; dir <= 1; dir += 2) {
        const nOff = dir * sd;
        for (let i = 0; i < CS; i++) {
          let any = false;
          const base = ORIGIN + i * sd;
          for (let b = 0; b < CS; b++) {
            let g = base + b * sv;
            let m = b * CS;
            for (let a = 0; a < CS; a++, g += su, m++) {
              const c = grid[g]!;
              if (c !== 0 && grid[g + nOff] === 0) {
                mask[m] = ao ? c | (aoKey(grid, g + nOff, su, sv) << 16) : c;
                any = true;
              } else mask[m] = 0;
            }
          }
          if (!any) continue;

          const plane = dir > 0 ? i + 1 : i;
          for (let b = 0; b < CS; b++) {
            for (let a = 0; a < CS; ) {
              const c = mask[a + b * CS]!;
              if (c === 0) {
                a++;
                continue;
              }
              // Cells merge only when identical (palette + AO on all 4 corners) AND the AO key is constant along the
              // merge axis, so the interpolated vertex shading across the merged quad equals the per-cell result.
              const k = c >>> 16;
              const l0 = k & 3, l1 = (k >> 2) & 3, l2 = (k >> 4) & 3, l3 = (k >> 6) & 3;
              const uInv = l0 === l1 && l2 === l3; // slots: (-,-),(+,-),(+,+),(-,+)
              const vInv = l0 === l3 && l1 === l2;
              let w = 1;
              let h = 1;
              if (uInv) while (a + w < CS && mask[a + w + b * CS] === c) w++;
              if (vInv) {
                outer: while (b + h < CS) {
                  for (let q = 0; q < w; q++) if (mask[a + q + (b + h) * CS] !== c) break outer;
                  h++;
                }
              }
              for (let hh = 0; hh < h; hh++) for (let k = 0; k < w; k++) mask[a + k + (b + hh) * CS] = 0;
              const pi = c & 0xffff;
              this.quad(d, u, v, dir, plane, a, b, a + w, b + h, pi < rgbN ? pi : 0, palette, c >>> 16);
              a += w;
            }
          }
        }
      }
    }

    if (this.vc === 0) return null;
    const vc = this.vc;
    const indices = vc > 65535 ? this.idx.slice(0, this.ic) : new Uint16Array(this.idx.subarray(0, this.ic));
    return {
      positions: this.pos.slice(0, vc * 3),
      normals: this.nrm.slice(0, vc * 3),
      colors: this.col.slice(0, vc * 3),
      indices,
      vertexCount: vc,
      triangleCount: this.ic / 3,
    };
  }

  private grow(): void {
    this.cap *= 2;
    const p = new Float32Array(this.cap * 3);
    p.set(this.pos);
    this.pos = p;
    const n = new Int8Array(this.cap * 3);
    n.set(this.nrm);
    this.nrm = n;
    const c = new Uint8Array(this.cap * 3);
    c.set(this.col);
    this.col = c;
    const i = new Uint32Array((this.cap / 4) * 6);
    i.set(this.idx);
    this.idx = i;
  }

  private quad(
    d: number, u: number, v: number, dir: number, plane: number,
    u0: number, v0: number, u1: number, v1: number, c: number, palette: Uint8Array, ao: number,
  ): void {
    if (this.vc + 4 > this.cap) this.grow();
    const vi = this.vc;
    // CCW seen from +d for (u0,v0),(u1,v0),(u1,v1),(u0,v1); reversed when facing -d.
    const cu = dir > 0 ? CU_P : CU_N;
    const cv = dir > 0 ? CV_P : CV_N;
    const r = palette[c * 3]!, g = palette[c * 3 + 1]!, b = palette[c * 3 + 2]!;
    for (let k = 0; k < 4; k++) {
      const o = (vi + k) * 3;
      this.pos[o + d] = plane;
      this.pos[o + u] = cu[k]! ? u1 : u0;
      this.pos[o + v] = cv[k]! ? v1 : v0;
      this.nrm[o] = 0;
      this.nrm[o + 1] = 0;
      this.nrm[o + 2] = 0;
      this.nrm[o + d] = dir * 127;
      const slot = cu[k]! ? (cv[k]! ? 2 : 1) : cv[k]! ? 3 : 0; // geometric corner as packed by aoKey
      const f = AO_LEVEL[(ao >> (2 * slot)) & 3]!;
      this.col[o] = r * f;
      this.col[o + 1] = g * f;
      this.col[o + 2] = b * f;
    }
        // split along the diagonal with the larger total occlusion (0fv.net rule): dark corners stay inside both triangles
    const flip = ((ao >> 2) & 3) + ((ao >> 6) & 3) > (ao & 3) + ((ao >> 4) & 3);
    const io = this.ic;
    if (flip) {
      this.idx[io] = vi + 1;
      this.idx[io + 1] = vi + 2;
      this.idx[io + 2] = vi + 3;
      this.idx[io + 3] = vi + 1;
      this.idx[io + 4] = vi + 3;
      this.idx[io + 5] = vi;
    } else {
      this.idx[io] = vi;
      this.idx[io + 1] = vi + 1;
      this.idx[io + 2] = vi + 2;
      this.idx[io + 3] = vi;
      this.idx[io + 4] = vi + 2;
      this.idx[io + 5] = vi + 3;
    }
    this.vc += 4;
    this.ic += 6;
  }
}

/** sRGB 0..255 palette -> linear RGB bytes (3 per entry), for vertex colours. */
export function buildLinearPalette(palette: ReadonlyArray<readonly [number, number, number]>): Uint8Array {
  const out = new Uint8Array(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    for (let k = 0; k < 3; k++) {
      const s = (palette[i]![k] ?? 0) / 255;
      const l = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      out[i * 3 + k] = Math.round(l * 255);
    }
  }
  return out;
}
