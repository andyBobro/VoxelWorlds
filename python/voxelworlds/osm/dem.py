"""Optional elevation. Primary source: Copernicus GLO-30 COG range reads (osm/copdem.py), bicubic-resampled
to a UTM-aligned lattice (E = a*sp, N = b*sp) that is finer than the voxel size (min 4 m, max 30 m).
Fallback: the free opentopodata public API (SRTM 30m, then mapzen) in blocks of 10x10 points, cached on disk.
Lattice values are a pure function of the lattice index, so tiles / overlapping bboxes share identical samples."""
from __future__ import annotations

import math
import threading
import time
from typing import Callable, Optional

import numpy as np
import requests
from pyproj import Transformer

from .. import cache
from ..config import Config
from ..voxel.grid import Grid
from ..protocol import log
from ..voxel.terrain import Terrain
from . import copdem

BLOCK = 10


def _fetch_block(ds: str, lat: np.ndarray, lon: np.ndarray, stop: threading.Event) -> Optional[np.ndarray]:
    locs = "|".join(f"{a:.6f},{b:.6f}" for a, b in zip(lat, lon))
    for attempt in range(3):
        if stop.is_set():
            return None
        try:
            r = requests.get(f"https://api.opentopodata.org/v1/{ds}", params={"locations": locs}, timeout=30)
            if r.status_code == 429:
                stop.wait(2.0 * (attempt + 1))
                continue
            r.raise_for_status()
            data = r.json()
            if data.get("status") != "OK":
                return None
            return np.array([np.nan if x.get("elevation") is None else x["elevation"]
                             for x in data["results"]], np.float64)
        except Exception:
            stop.wait(1.5)
    return None


def _fetch_raster(grid: Grid, cfg: Config, tick: Callable[[float], None],
                  stop: threading.Event) -> Terrain:  # noqa: C901
    """GLO-30 terrain on a UTM lattice with spacing clamp(ceil(voxel), 4, 30) m (coarser only to bound size)."""
    w, h = grid.nx * grid.vs, grid.nz * grid.vs
    sp = float(min(cfg.dem_spacing_m, max(cfg.dem_raster_min_spacing_m, math.ceil(grid.vs))))
    sp = max(sp, float(math.ceil(max(w, h) / cfg.dem_raster_max_samples_per_axis)))
    a0, a1 = int(math.floor(grid.e0 / sp)) - 2, int(math.ceil((grid.e0 + w) / sp)) + 2
    b0, b1 = int(math.floor((grid.n0 - h) / sp)) - 2, int(math.ceil(grid.n0 / sp)) + 2
    na, nb = a1 - a0 + 1, b1 - b0 + 1
    to_wgs = Transformer.from_crs(grid.epsg, 4326, always_xy=True)
    z = np.empty((nb, na), np.float64)
    src = copdem.Source(cfg, stop)  # one session + decoded-tile LRU for all strips
    rows = max(1, 400_000 // na)
    for r in range(0, nb, rows):
        if stop.is_set():
            raise copdem.DemUnavailable("cancelled")
        r1 = min(nb, r + rows)
        ge, gn = np.meshgrid((np.arange(na) + a0) * sp, (np.arange(r, r1) + b0) * sp)
        lon, lat = to_wgs.transform(ge, gn)
        z[r:r1] = copdem.sample_with(src, np.asarray(lon), np.asarray(lat))
        tick(r1 / nb)
    z = z.astype(np.float32)  # compact + identical in every consumer
    return Terrain(sp, a0, b0, z, float(np.floor(float(z.min())) - cfg.dem_datum_margin_m))


def fetch_terrain(grid: Grid, cfg: Config, tick: Callable[[float], None],
                  stop: Optional[threading.Event] = None,
                  warn: Optional[Callable[[str, str], None]] = None) -> Optional[Terrain]:
    """Terrain for the whole grid (None on failure): GLO-30 raster first (one retry), then opentopodata.
    Falling back is reported through ``warn(code, message)`` - the degraded source is never silent."""
    stop = stop or threading.Event()
    err: Optional[Exception] = None
    for attempt in range(2):
        try:
            return _fetch_raster(grid, cfg, tick, stop)
        except Exception as e:
            if stop.is_set():
                return None
            err = e
            log(f"GLO-30 raster DEM attempt {attempt + 1}/2 failed ({type(e).__name__}: {str(e)[:160]})")
            if attempt == 0:
                stop.wait(1.5)
    if warn is not None:
        warn("DEM_FALLBACK", "Copernicus GLO-30 elevation unavailable "
             f"({type(err).__name__}: {str(err)[:120]}); using the coarser opentopodata API (30 m, slow)")
    return _fetch_opentopo(grid, cfg, tick, stop)


def _fetch_opentopo(grid: Grid, cfg: Config, tick: Callable[[float], None],
                    stop: threading.Event) -> Optional[Terrain]:
    to_wgs = Transformer.from_crs(grid.epsg, 4326, always_xy=True)
    w, h = grid.nx * grid.vs, grid.nz * grid.vs
    sp = max(cfg.dem_spacing_m, max(w, h) / max(1, cfg.dem_max_samples_per_axis - 1))
    sp = float(math.ceil(sp))  # integer metres: stable cache keys
    emin, emax = grid.e0, grid.e0 + w
    nmin, nmax = grid.n0 - h, grid.n0
    a0, a1 = int(math.floor(emin / sp)) - 1, int(math.ceil(emax / sp)) + 1
    b0, b1 = int(math.floor(nmin / sp)) - 1, int(math.ceil(nmax / sp)) + 1
    na, nb = a1 - a0 + 1, b1 - b0 + 1
    bi0, bi1 = a0 // BLOCK, a1 // BLOCK
    bj0, bj1 = b0 // BLOCK, b1 // BLOCK
    blocks = [(bi, bj) for bj in range(bj0, bj1 + 1) for bi in range(bi0, bi1 + 1)]
    for ds in cfg.dem_datasets:
        z = np.full((nb, na), np.nan)
        ok = True
        last_req = 0.0
        for k, (bi, bj) in enumerate(blocks):
            if stop.is_set():
                return None
            key = f"dem|{ds}|{grid.epsg}|{sp:g}|{bi}|{bj}"
            vals = cache.get_array("dem", key, cfg.dem_cache_ttl_s)
            if vals is None:
                aa = np.arange(bi * BLOCK, (bi + 1) * BLOCK)
                bb = np.arange(bj * BLOCK, (bj + 1) * BLOCK)
                ge, gn = np.meshgrid(aa * sp, bb * sp)  # (BLOCK, BLOCK): rows = b, cols = a
                lon, lat = to_wgs.transform(ge.ravel(), gn.ravel())
                wait = 1.1 - (time.monotonic() - last_req)  # public API: 1 request / second
                if wait > 0 and last_req:
                    stop.wait(wait)
                last_req = time.monotonic()
                v = _fetch_block(ds, np.asarray(lat), np.asarray(lon), stop)
                if v is None:
                    ok = False
                    break
                vals = v.reshape(BLOCK, BLOCK)
                if np.isfinite(vals).all():
                    cache.put_array("dem", key, vals)
            # paste into z
            for r in range(BLOCK):
                b = bj * BLOCK + r - b0
                if 0 <= b < nb:
                    ca0, ca1 = max(a0, bi * BLOCK), min(a1, (bi + 1) * BLOCK - 1)
                    z[b, ca0 - a0:ca1 - a0 + 1] = vals[r, ca0 - bi * BLOCK:ca1 - bi * BLOCK + 1]
            tick((k + 1) / len(blocks))
        if ok and np.isfinite(z).sum() >= max(1, int(0.5 * z.size)):
            z = np.where(np.isfinite(z), z, np.nanmedian(z))
            return Terrain(sp, a0, b0, z, float(np.floor(z.min())) - cfg.dem_datum_margin_m)
    return None
