/** Pure homography helpers for the rectified preview (renderer-side warp; avoids reading rectifiedPath). */

export type Pt = readonly [number, number];
export type Quad = readonly [Pt, Pt, Pt, Pt]; // TL, TR, BR, BL

/** Unit square (s right, t down; TL=(0,0), TR=(1,0), BR=(1,1), BL=(0,1)) -> quad; returns 3x3 row-major H. */
export function squareToQuad(q: Quad): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1e-12) throw new Error('degenerate quad');
    g = (dx3 * dy2 - dx2 * dy3) / det;
    h = (dx1 * dy3 - dx3 * dy1) / det;
  }
  // points order: (0,0)->q0, (1,0)->q1, (1,1)->q2, (0,1)->q3
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  return [a, b, c, d, e, f, g, h, 1];
}

export function applyH(H: ReadonlyArray<number>, s: number, t: number): [number, number] {
  const w = H[6]! * s + H[7]! * t + H[8]!;
  return [(H[0]! * s + H[1]! * t + H[2]!) / w, (H[3]! * s + H[4]! * t + H[5]!) / w];
}

/** Convex with the TL,TR,BR,BL winding of a y-down image: every corner cross product > 0 (rejects mirrored/flipped/bow-tie quads). */
export function quadIsConvex(q: Quad): boolean {
  for (let i = 0; i < 4; i++) {
    const a = q[i]!, b = q[(i + 1) % 4]!, c = q[(i + 2) % 4]!;
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 1e-9) return false;
  }
  return true;
}

export function quadArea(q: Quad): number {
  let s = 0;
  for (let i = 0; i < 4; i++) { const a = q[i]!, b = q[(i + 1) % 4]!; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}

export const MIN_QUAD_AREA_FRAC = 0.01;
export const MIN_CORNER_SIN = 0.26; // ~15 degrees: rejects slivers

/** null when usable, else a user-facing reason. Image size in the same pixel space as the corners. */
export function validateQuad(q: Quad, imgW: number, imgH: number): string | null {
  if (!quadIsConvex(q)) return 'Corners must be ordered TL, TR, BR, BL without crossing or mirroring.';
  if (quadArea(q) < MIN_QUAD_AREA_FRAC * imgW * imgH) return 'The marked wall is too small (under 1% of the photo).';
  for (let i = 0; i < 4; i++) {
    const a = q[i]!, b = q[(i + 1) % 4]!, c = q[(i + 2) % 4]!;
    const ux = b[0] - a[0], uz = b[1] - a[1], vx = c[0] - b[0], vz = c[1] - b[1];
    if (Math.hypot(ux, uz) < 0.03 * Math.max(imgW, imgH)) return 'The marked wall is too thin; move the corners to the real wall corners.';
    const sin = (ux * vz - uz * vx) / ((Math.hypot(ux, uz) * Math.hypot(vx, vz)) || 1);
    if (sin < MIN_CORNER_SIN) return 'The marked wall is too thin or skewed; move the corners to the real wall corners.';
  }
  return null;
}

/**
 * Warp RGBA `src` (sw x sh) through quad into out (ow x oh), bilinear. Pure; `out` is RGBA.
 */
export function rectify(src: Uint8ClampedArray, sw: number, sh: number, q: Quad, out: Uint8ClampedArray, ow: number, oh: number): void {
  const H = squareToQuad(q);
  for (let j = 0; j < oh; j++) {
    const t = (j + 0.5) / oh;
    for (let i = 0; i < ow; i++) {
      const [x, y] = applyH(H, (i + 0.5) / ow, t);
      const o = (j * ow + i) * 4;
      const fx = x - 0.5, fy = y - 0.5;
      if (!(fx > -1 && fy > -1 && fx < sw && fy < sh)) { out[o] = out[o + 1] = out[o + 2] = 40; out[o + 3] = 255; continue; }
      const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
      const xa = Math.max(0, Math.min(sw - 1, x0)), xb = Math.max(0, Math.min(sw - 1, x0 + 1));
      const ya = Math.max(0, Math.min(sh - 1, y0)), yb = Math.max(0, Math.min(sh - 1, y0 + 1));
      for (let k = 0; k < 3; k++) {
        const p00 = src[(ya * sw + xa) * 4 + k]!, p10 = src[(ya * sw + xb) * 4 + k]!;
        const p01 = src[(yb * sw + xa) * 4 + k]!, p11 = src[(yb * sw + xb) * 4 + k]!;
        out[o + k] = (p00 * (1 - ax) + p10 * ax) * (1 - ay) + (p01 * (1 - ax) + p11 * ax) * ay;
      }
      out[o + 3] = 255;
    }
  }
}
