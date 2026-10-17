"""Street-level environment: trees (OSM natural=tree nodes + procedural scatter in woods/parks), street lamps
and barriers (fence / wall / hedge). Props are plain tuples built once from the OSM gdf (UTM), then voxelized
per tile as pure functions of global cell coordinates, so tile seams and worker counts never change the result.

  ("tree", e, n, height_m, crown_m, conifer, seed)
  ("lamp", e, n, height_m)
  ("bar",  polygon, height_m, (r, g, b))
"""
from __future__ import annotations

import zlib
from typing import List, Optional, Tuple

import numpy as np
import shapely
from shapely.geometry import Point

from ..config import Config
from ..osm.fetch import _tag, parse_length_m, polygons_of
from .grid import Grid, cells_in_geom
from .terrain import Terrain, ground_points

BROADLEAF = [(70, 120, 52), (84, 132, 60), (62, 108, 48), (96, 140, 64), (78, 126, 70)]
CONIFER = [(40, 86, 52), (48, 96, 60), (36, 78, 48)]
TRUNK = (96, 72, 50)
POLE = (62, 62, 66)
LAMP_HEAD = (250, 240, 190)
BARRIERS = {  # tag value -> (height m, width m, rgb)
    "fence": (1.2, 0.3, (150, 124, 92)), "wall": (1.8, 0.45, (170, 164, 156)),
    "retaining_wall": (1.5, 0.5, (150, 148, 144)), "hedge": (1.5, 0.8, (60, 104, 50)),
    "city_wall": (5.0, 1.0, (180, 170, 150)), "guard_rail": (0.8, 0.3, (170, 172, 176)),
}
MAX_PROPS = 60000
FOREST_SPACING_M = 6.0
PARK_SPACING_M = 14.0


def _h(*vals) -> float:
    """Deterministic uniform [0,1) from integers/strings."""
    s = "|".join(str(v) for v in vals).encode()
    return (zlib.crc32(s) & 0xFFFFFF) / float(1 << 24)


def _scatter(poly, spacing: float, kind: str, seed: int, out: list, conifer: bool) -> None:
    minx, miny, maxx, maxy = poly.bounds
    i0, i1 = int(np.floor(minx / spacing)), int(np.ceil(maxx / spacing))
    j0, j1 = int(np.floor(miny / spacing)), int(np.ceil(maxy / spacing))
    ii, jj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
    ii, jj = ii.ravel(), jj.ravel()
    if len(ii) > 400_000:
        return
    # jitter by lattice cell (global), so the same tree is produced regardless of which polygon/tile sees it
    jx = np.array([_h(seed, "jx", int(a), int(b)) for a, b in zip(ii, jj)])
    jy = np.array([_h(seed, "jy", int(a), int(b)) for a, b in zip(ii, jj)])
    e = (ii + 0.15 + 0.7 * jx) * spacing
    n = (jj + 0.15 + 0.7 * jy) * spacing
    m = shapely.contains_xy(poly, e, n)
    for a, b, ee, nn in zip(ii[m], jj[m], e[m], n[m]):
        u = _h(seed, "h", int(a), int(b))
        height = (8.0 + 6.0 * u) if kind == "wood" else (5.0 + 5.0 * u)
        crown = float(np.clip(0.55 * height + 1.0 + 1.5 * _h(seed, "c", int(a), int(b)), 3.0, 8.0))
        out.append(("tree", float(ee), float(nn), height, crown, conifer, int(a) * 73856093 ^ int(b) * 19349663))


def build_props(gdf_utm, cfg: Config, check=None) -> List[tuple]:
    """Trees, lamps and barriers from OSM features (UTM gdf)."""
    out: List[tuple] = []
    if gdf_utm is None or len(gdf_utm) == 0:
        return out
    cols = set(gdf_utm.columns)
    g = lambda r, k: (_tag(r, k) if k in cols else None)
    for n_row, (_, row) in enumerate(gdf_utm.iterrows()):
        if check is not None and n_row % 500 == 0:
            check()
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue
        t = geom.geom_type
        if t == "Point":
            if g(row, "natural") == "tree":
                h = parse_length_m(g(row, "height")) or (6.0 + 4.0 * _h(cfg.seed, "th", round(geom.x, 1), round(geom.y, 1)))
                cw = parse_length_m(g(row, "diameter_crown")) or float(np.clip(0.55 * h + 1.0, 3.0, 8.0))
                con = (g(row, "leaf_type") or "") == "needleleaved"
                out.append(("tree", float(geom.x), float(geom.y), float(np.clip(h, 2.0, 40.0)), cw, con,
                            int(geom.x * 10) * 73856093 ^ int(geom.y * 10) * 19349663))
            elif g(row, "highway") == "street_lamp" or g(row, "man_made") == "street_lamp":
                out.append(("lamp", float(geom.x), float(geom.y), 4.5 + 1.5 * _h(cfg.seed, "lh", round(geom.x, 1))))
        elif t in ("Polygon", "MultiPolygon"):
            if g(row, "building") or g(row, "building:part"):
                continue
            wood = g(row, "natural") == "wood" or g(row, "landuse") == "forest"
            park = g(row, "leisure") in ("park", "garden") and not wood
            if wood or park:
                con = (g(row, "leaf_type") or "") == "needleleaved"
                for p in polygons_of(geom):
                    _scatter(p, FOREST_SPACING_M if wood else PARK_SPACING_M, "wood" if wood else "park",
                             cfg.seed, out, con)
        if t in ("LineString", "MultiLineString"):
            b = g(row, "barrier")
            if b in BARRIERS:
                hgt, wid, rgb = BARRIERS[b]
                hh = parse_length_m(g(row, "height"))
                poly = geom.buffer(max(wid, 0.3) / 2.0, cap_style="flat")
                if not poly.is_empty:
                    out.append(("bar", poly, float(hh) if hh and 0.3 <= hh <= 10 else hgt, rgb, wid))
        if len(out) >= MAX_PROPS:
            break
    return out


def prop_geom(p: tuple):
    return p[1] if p[0] == "bar" else Point(p[1], p[2])


def _noise(x, y, z) -> np.ndarray:
    return (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) & 0xFF).astype(np.int64)


def _tree_voxels(p, grid: Grid, terrain: Optional[Terrain]):
    _, e, n, height, crown, conifer, seed = p
    vs = grid.vs
    cx = int(np.floor((e - grid.e0) / vs))
    cz = int(np.floor((grid.n0 - n) / vs))
    gy = int(ground_points(terrain, grid, np.array([cz]), np.array([cx]))[0])
    trunk_h = max(1, int(round(0.38 * height / vs)))
    R = max(1.0, crown / 2.0 / vs)
    crown_h = max(2, int(round((height - 0.38 * height) / vs)))
    cy0 = gy + 1 + trunk_h - (1 if crown_h > 3 else 0)  # crown base
    ri = int(np.ceil(R))
    dx, dy, dz = np.meshgrid(np.arange(-ri, ri + 1), np.arange(0, crown_h + 1), np.arange(-ri, ri + 1), indexing="ij")
    rr = np.hypot(dx, dz)
    t = dy / max(1.0, float(crown_h))  # 0 base .. 1 top
    if conifer:
        inside = rr <= R * (1.0 - t) + 0.3
    else:
        rv = crown_h / 2.0
        inside = (rr / R) ** 2 + ((dy - rv) / rv) ** 2 <= 1.0
    shell = max(1, int(round(1.3 / vs)))
    if inside.any() and crown_h > 2 * shell + 1 and ri > shell:  # hollow crown: surface voxels only
        inner = (rr <= (R - shell)) & (dy >= shell) & (dy <= crown_h - shell) if not conifer else \
            (rr <= np.maximum(0.0, R * (1.0 - t) - shell)) & (dy >= shell) & (dy <= crown_h - shell)
        inside &= ~inner
    X = (cx + dx[inside]).astype(np.int32)
    Y = (cy0 + dy[inside]).astype(np.int32)
    Z = (cz + dz[inside]).astype(np.int32)
    pal = np.array(CONIFER if conifer else BROADLEAF, np.int64)
    # leaf colour: the preview only merges equal colours, so vary it on ~1 m blocks (and per tree at >= 1 m)
    bsz = max(1, int(round(1.0 / vs)))
    Xi, Yi, Zi = X.astype(np.int64), Y.astype(np.int64), Z.astype(np.int64)
    if vs >= 1.0:
        k = np.full(len(X), (seed & 0xFF) % len(pal), np.int64)
        jit = np.zeros(len(X), np.int64)
    else:
        k = (_noise(Xi // bsz, Yi // bsz, Zi // bsz) + (seed & 0xFF)) % len(pal)
        jit = ((_noise(Zi // bsz, Xi // bsz, Yi // bsz) % 3) - 1) * 6
    rgb = np.clip(pal[k] + jit[:, None], 0, 255).astype(np.uint8)
    # trunk
    ty = np.arange(gy + 1, cy0 + max(1, crown_h // 3), dtype=np.int32)
    tw = 2 if vs <= 0.25 else 1
    tx = np.repeat(np.arange(cx, cx + tw), tw * len(ty))
    tz = np.tile(np.repeat(np.arange(cz, cz + tw), len(ty)), tw)
    ty_all = np.tile(ty, tw * tw)
    trgb = np.tile(np.array(TRUNK, np.uint8), (len(ty_all), 1))
    return (np.concatenate([X, tx.astype(np.int32)]), np.concatenate([Y, ty_all]),
            np.concatenate([Z, tz.astype(np.int32)]), np.concatenate([rgb, trgb]), 5)  # vegetation


def _lamp_voxels(p, grid: Grid, terrain: Optional[Terrain]):
    _, e, n, height = p
    vs = grid.vs
    cx = int(np.floor((e - grid.e0) / vs))
    cz = int(np.floor((grid.n0 - n) / vs))
    gy = int(ground_points(terrain, grid, np.array([cz]), np.array([cx]))[0])
    hv = max(2, int(round(height / vs)))
    ys = np.arange(gy + 1, gy + 1 + hv, dtype=np.int32)
    X = np.full(len(ys), cx, np.int32)
    Z = np.full(len(ys), cz, np.int32)
    rgb = np.tile(np.array(POLE, np.uint8), (len(ys), 1))
    rgb[-1] = LAMP_HEAD
    if vs <= 0.5:  # short arm with the lamp head at its end
        X = np.concatenate([X, np.array([cx + 1], np.int32)])
        Z = np.concatenate([Z, np.array([cz], np.int32)])
        ys = np.concatenate([ys, np.array([ys[-1]], np.int32)])
        rgb = np.concatenate([rgb, np.array([LAMP_HEAD], np.uint8)])
    return X, ys, Z, rgb, 6  # other


def voxelize_prop(p: tuple, grid: Grid, terrain: Optional[Terrain], core: Tuple[int, int, int, int]):
    """(x, y, z, rgb uint8 (n,3), material index) of one prop restricted to the tile `core`, or None."""
    kind = p[0]
    ix0, iz0, ix1, iz1 = core
    if kind == "bar":
        _, poly, hgt, rgb, _w = p
        ix, iz = cells_in_geom(poly, grid, core)
        if len(ix) == 0:
            return None
        gy = ground_points(terrain, grid, iz, ix).astype(np.int64)
        hv = max(1, int(round(hgt / grid.vs)))
        rep = np.repeat(np.arange(len(ix)), hv)
        off = np.tile(np.arange(hv), len(ix))
        X, Z = ix[rep], iz[rep]
        Y = (gy[rep] + 1 + off).astype(np.int32)
        return X, Y, Z, np.tile(np.array(rgb, np.uint8), (len(X), 1)), 6
    res = _tree_voxels(p, grid, terrain) if kind == "tree" else _lamp_voxels(p, grid, terrain)
    X, Y, Z, rgb, mat = res
    m = (X >= ix0) & (X < ix1) & (Z >= iz0) & (Z < iz1)
    if not m.any():
        return None
    return X[m], Y[m], Z[m], rgb[m], mat
