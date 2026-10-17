"""Projection (WGS84 -> UTM) and the voxel grid definition + polygon rasterization."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np
import shapely
from pyproj import Transformer


@dataclass
class Grid:
    """Voxel grid: x east, z south (rows), y up. Voxel (ix,iz) covers
    E in [e0+ix*vs, +vs), N in (n0-(iz+1)*vs, n0-iz*vs]."""
    epsg: int
    zone: int
    hemisphere: str
    e0: float
    n0: float
    vs: float
    nx: int
    nz: int

    def centers_e(self, ix: np.ndarray) -> np.ndarray:
        return self.e0 + (ix + 0.5) * self.vs

    def centers_n(self, iz: np.ndarray) -> np.ndarray:
        return self.n0 - (iz + 0.5) * self.vs


def utm_epsg(lat: float, lon: float) -> Tuple[int, int, str]:
    zone = int((lon + 180.0) // 6.0) + 1
    zone = max(1, min(60, zone))
    if lat >= 0:
        return 32600 + zone, zone, "N"
    return 32700 + zone, zone, "S"


INT32_MAX = 2**31 - 1


def make_grid(bbox: dict, voxel_size: float) -> Tuple[Grid, Transformer]:
    """Grid whose origin is snapped to the GLOBAL voxel lattice (multiples of voxel_size in UTM), so
    grids of different bboxes / tiles at the same voxel size share exact voxel boundaries."""
    clat = (bbox["latMin"] + bbox["latMax"]) / 2.0
    clon = (bbox["lonMin"] + bbox["lonMax"]) / 2.0
    epsg, zone, hemi = utm_epsg(clat, clon)
    tr = Transformer.from_crs(4326, epsg, always_xy=True)
    lons = [bbox["lonMin"], bbox["lonMax"], bbox["lonMin"], bbox["lonMax"]]
    lats = [bbox["latMin"], bbox["latMin"], bbox["latMax"], bbox["latMax"]]
    xs, ys = tr.transform(lons, lats)
    gi0 = int(math.floor(min(xs) / voxel_size))
    gi1 = int(math.ceil(max(xs) / voxel_size))
    gj_top = int(math.ceil(max(ys) / voxel_size))
    gj_bot = int(math.floor(min(ys) / voxel_size))
    nx = max(1, gi1 - gi0)
    nz = max(1, gj_top - gj_bot)
    return Grid(epsg, zone, hemi, gi0 * voxel_size, gj_top * voxel_size, voxel_size, nx, nz), tr


def cells_in_geom(geom, grid: Grid, window: Optional[Tuple[int, int, int, int]] = None,
                  max_chunk: int = 2_000_000, check=None) -> Tuple[np.ndarray, np.ndarray]:
    """Return (ix, iz) (global grid indices) of cells whose centre lies inside `geom` (UTM coords),
    restricted to `window` = (ix0, iz0, ix1, iz1) exclusive upper bounds (default: whole grid)."""
    wx0, wz0, wx1, wz1 = window if window is not None else (0, 0, grid.nx, grid.nz)
    if geom is None or geom.is_empty:
        return np.empty(0, np.int32), np.empty(0, np.int32)
    minx, miny, maxx, maxy = geom.bounds
    ix0 = max(wx0, int(math.floor((minx - grid.e0) / grid.vs)))
    ix1 = min(wx1 - 1, int(math.floor((maxx - grid.e0) / grid.vs)))
    iz0 = max(wz0, int(math.floor((grid.n0 - maxy) / grid.vs)))
    iz1 = min(wz1 - 1, int(math.floor((grid.n0 - miny) / grid.vs)))
    if ix1 < ix0 or iz1 < iz0:
        return np.empty(0, np.int32), np.empty(0, np.int32)
    w = ix1 - ix0 + 1
    rows_per = max(1, max_chunk // w)
    xs_all = []
    zs_all = []
    ix = np.arange(ix0, ix1 + 1)
    ex = grid.centers_e(ix)
    if check is not None:
        rows_per = max(1, min(rows_per, 500_000 // w))
    for r0 in range(iz0, iz1 + 1, rows_per):
        if check is not None:
            check()
        r1 = min(iz1, r0 + rows_per - 1)
        iz = np.arange(r0, r1 + 1)
        nn = grid.centers_n(iz)
        gx, gn = np.meshgrid(ex, nn)
        m = shapely.contains_xy(geom, gx.ravel(), gn.ravel())
        if m.any():
            idx = np.nonzero(m)[0]
            xs_all.append((idx % w + ix0).astype(np.int32))
            zs_all.append((idx // w + r0).astype(np.int32))
    if not xs_all:
        return np.empty(0, np.int32), np.empty(0, np.int32)
    return np.concatenate(xs_all), np.concatenate(zs_all)
