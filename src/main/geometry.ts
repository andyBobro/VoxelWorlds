/**
 * Pure planar geometry on [lon, lat] rings, used to match a bbox against Geofabrik region polygons.
 * Geofabrik polygons are GeoJSON MultiPolygons: polygon = [outerRing, ...holes], ring = [[lon, lat], ...].
 */
import type { BBox } from '../shared/contract';

export type Pt = [number, number];
export type Ring = Pt[];
export type Poly = Ring[]; // [outer, ...holes]

export function ringBBox(r: Ring): BBox {
  let latMin = Infinity,
    lonMin = Infinity,
    latMax = -Infinity,
    lonMax = -Infinity;
  for (const [x, y] of r) {
    if (x < lonMin) lonMin = x;
    if (x > lonMax) lonMax = x;
    if (y < latMin) latMin = y;
    if (y > latMax) latMax = y;
  }
  return { latMin, lonMin, latMax, lonMax };
}

export function pointInRing(x: number, y: number, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Even-odd over outer ring and holes. */
export function pointInPoly(x: number, y: number, p: Poly): boolean {
  if (!p.length || !pointInRing(x, y, p[0])) return false;
  for (let i = 1; i < p.length; i++) if (pointInRing(x, y, p[i])) return false;
  return true;
}

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
  (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** Proper or touching segment intersection. */
export function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a[0], a[1], b[0], b[1], c[0], c[1]);
  const o2 = orient(a[0], a[1], b[0], b[1], d[0], d[1]);
  const o3 = orient(c[0], c[1], d[0], d[1], a[0], a[1]);
  const o4 = orient(c[0], c[1], d[0], d[1], b[0], b[1]);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const on = (p: Pt, q: Pt, r: Pt): boolean =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}

const corners = (b: BBox): Pt[] => [
  [b.lonMin, b.latMin],
  [b.lonMax, b.latMin],
  [b.lonMax, b.latMax],
  [b.lonMin, b.latMax],
];

const bboxOverlap = (a: BBox, b: BBox): boolean =>
  a.lonMin <= b.lonMax && a.lonMax >= b.lonMin && a.latMin <= b.latMax && a.latMax >= b.latMin;

const inBBoxStrict = (b: BBox, [x, y]: Pt): boolean => x > b.lonMin && x < b.lonMax && y > b.latMin && y < b.latMax;

/** Does any ring edge cross the bbox boundary / any ring vertex lie strictly inside the bbox? */
function boundaryEntersBBox(p: Poly, b: BBox): boolean {
  const cs = corners(b);
  for (const ring of p) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (inBBoxStrict(b, ring[i])) return true;
      for (let k = 0; k < 4; k++) if (segmentsIntersect(ring[j], ring[i], cs[k], cs[(k + 1) % 4])) return true;
    }
  }
  return false;
}

function singlePolyCovers(mp: Poly[], b: BBox): boolean {
  const cs = corners(b);
  for (const p of mp) {
    if (!p.length || !bboxOverlap(ringBBox(p[0]), b)) continue;
    if (cs.every(([x, y]) => pointInPoly(x, y, p)) && !boundaryEntersBBox(p, b)) return true;
  }
  return false;
}

/**
 * True when the bbox lies inside the multipolygon. A bbox that straddles the seam between two adjoining parts is
 * covered by their union even though no single part contains it, so on failure the bbox is split into quadrants
 * (up to `depth` levels) and every quadrant must be covered by some part; at the finest level a cell counts as covered when its centre is inside a part (approximation).
 */
export function multiPolyCoversBBox(mp: Poly[], b: BBox, depth = 4): boolean {
  if (singlePolyCovers(mp, b)) return true;
  if (mp.length < 2 || !multiPolyIntersectsBBox(mp, b)) return false;
  if (depth <= 0) {
    // leaf cell (1/16 of the bbox per axis) that straddles a seam: decide by its centre point
    const x = (b.lonMin + b.lonMax) / 2;
    const y = (b.latMin + b.latMax) / 2;
    return mp.some((p) => pointInPoly(x, y, p));
  }
  const lonMid = (b.lonMin + b.lonMax) / 2;
  const latMid = (b.latMin + b.latMax) / 2;
  const quads: BBox[] = [
    { latMin: b.latMin, lonMin: b.lonMin, latMax: latMid, lonMax: lonMid },
    { latMin: b.latMin, lonMin: lonMid, latMax: latMid, lonMax: b.lonMax },
    { latMin: latMid, lonMin: b.lonMin, latMax: b.latMax, lonMax: lonMid },
    { latMin: latMid, lonMin: lonMid, latMax: b.latMax, lonMax: b.lonMax },
  ];
  return quads.every((q) => multiPolyCoversBBox(mp, q, depth - 1));
}

/** True when the multipolygon and the bbox share any area (or touch). */
export function multiPolyIntersectsBBox(mp: Poly[], b: BBox): boolean {
  const cs = corners(b);
  for (const p of mp) {
    if (!p.length || !bboxOverlap(ringBBox(p[0]), b)) continue;
    if (cs.some(([x, y]) => pointInPoly(x, y, p))) return true;
    if (boundaryEntersBBox(p, b)) return true;
  }
  return false;
}

/** Approximate area in km^2 (planar shoelace with a cos(lat) correction; only used to rank regions). */
export function multiPolyAreaKm2(mp: Poly[]): number {
  const ringArea = (r: Ring): number => {
    let s = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    return Math.abs(s) / 2;
  };
  let total = 0;
  for (const p of mp) {
    if (!p.length) continue;
    const bb = ringBBox(p[0]);
    const k = Math.cos((((bb.latMin + bb.latMax) / 2) * Math.PI) / 180);
    let a = ringArea(p[0]);
    for (let i = 1; i < p.length; i++) a -= ringArea(p[i]);
    total += a * k * 111.32 * 110.57;
  }
  return total;
}
