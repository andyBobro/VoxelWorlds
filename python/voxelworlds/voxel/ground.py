"""Ground columns: land-cover / road / water painting, water carving, slope skirts, per-cell colour variation.

Everything here is a pure function of GLOBAL cell indices (terrain height, water level, neighbour heights,
colour noise), so tile size and worker count never change the output. Neighbour heights for skirts are
computed on a 1-cell halo around the tile core with the same function, never from tile-local state."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import numpy as np
import shapely

from ..config import Config
from ..protocol import PipelineError
from .grid import Grid, cells_in_geom
from .terrain import Terrain

MAT_GROUND = 0
NO_WATER = -(2 ** 30)
FOLLOW = -(2 ** 29)   # water level 'follow the terrain': surface = ground - drop (steep streams / river polygons)


@dataclass
class Layer:
    """One homogeneous paint layer (later layers win). ``levels`` (water only) gives a flat water-surface
    voxel height per polygon."""
    rgb: Tuple[int, int, int]
    mat: int
    polys: list
    jit: float = 0.0        # per-cell brightness jitter (%)
    patch: float = 0.0      # ~6 m patch brightness variation (%)
    checker: float = 0.0    # alternating-cell brightness (%), e.g. pavers
    levels: Optional[List[int]] = None
    quant: Optional[List[float]] = None   # water: percentile of terrain under each polygon used as level
    deck: bool = False                    # bridge deck: levels = deck voxel height per polygon, ground untouched
    meta: Optional[list] = None           # deck: (e_a, n_a, e_b, n_b, t) per polygon; t = position along the way


def pack(rgb: np.ndarray, mat) -> np.ndarray:
    rgb = rgb.reshape(-1, 3)
    c = (rgb[:, 0].astype(np.uint32) << 16) | (rgb[:, 1].astype(np.uint32) << 8) | rgb[:, 2].astype(np.uint32)
    return (c << 3) | np.asarray(mat, np.uint32)


def hash01(ix, iz, salt: int) -> np.ndarray:
    """Deterministic uniform [0,1) noise from integer cell indices."""
    m = np.uint64(0xFFFFFFFF)
    h = (np.asarray(ix, np.int64).astype(np.uint64) * np.uint64(0x9E3779B1) +
         np.asarray(iz, np.int64).astype(np.uint64) * np.uint64(0x85EBCA77) +
         np.uint64(salt * 0xC2B2AE3D & 0xFFFFFFFF)) & m
    h ^= h >> np.uint64(15)
    h = (h * np.uint64(0x2C1B3C6D)) & m
    h ^= h >> np.uint64(12)
    h = (h * np.uint64(0x297A2D39)) & m
    h ^= h >> np.uint64(15)
    return h.astype(np.float64) / 4294967296.0


def brightness(ix, iz, jit, patch, checker, vs: float) -> np.ndarray:
    """Quantised (1 %) brightness factor per cell; jit/patch/checker are per-cell amplitude arrays in %.
    Fragmentation-aware: the preview mesher only merges equal colours, so per-cell noise is scaled with the
    voxel size - none at >= 1 m (only the ~6 m patches remain), 1 m cells with 3 levels at 0.5 m, 0.5 m cells
    below; checkerboards only at <= 0.35 m."""
    ix, iz = np.asarray(ix), np.asarray(iz)
    kb = max(1, int(round(6.0 / vs)))
    kc = max(1, int(round(0.5 / vs)))
    n2 = hash01(ix // kb, iz // kb, 2) * 2 - 1
    f = 1.0 + patch * n2 / 100.0
    if vs < 1.0:
        kj = max(1, int(round((1.0 if vs >= 0.5 else 0.5) / vs)))
        n1 = np.floor(hash01(ix // kj, iz // kj, 1) * 3.0) - 1.0  # {-1, 0, 1}
        f = f + jit * n1 / 100.0
    if vs <= 0.35:
        c = (((ix // kc) + (iz // kc)) & 1) * 2 - 1
        f = f + checker * c / 100.0
    return np.round(f * 100.0) / 100.0


def ground_voxels(g: Grid, terrain: Optional[Terrain], cfg: Config, layers: List[Layer],
                  core: Tuple[int, int, int, int], ctl, max_vox: Optional[int] = None) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Voxels (x, y, z, packed code) of every ground column in ``core``: surface voxel (land cover colour,
    or water at its flat level) plus skirt voxels down to the lowest 4-neighbour surface so slopes are sealed.
    Water columns always get a bed voxel underneath."""
    ix0, iz0, ix1, iz1 = core
    nxt, nzt = ix1 - ix0, iz1 - iz0
    wx0, wz0, wx1, wz1 = max(0, ix0 - 1), max(0, iz0 - 1), min(g.nx, ix1 + 1), min(g.nz, iz1 + 1)
    win = (wx0, wz0, wx1, wz1)
    hw, ww = wz1 - wz0, wx1 - wx0
    gh = terrain.block(g, wz0, wz1, wx0, wx1) if terrain is not None else np.zeros((hw, ww), np.int32)
    col = np.empty((hw, ww, 3), np.uint8)
    col[:] = cfg.ground_color
    sty = np.zeros((hw, ww), np.uint8)
    mat = np.full((hw, ww), MAT_GROUND, np.uint8)
    wl = np.full((hw, ww), NO_WATER, np.int32)
    amps = [(cfg.ground_jitter_pct, cfg.ground_patch_pct, 0.0)]
    nl = max(1, len(layers))
    for li, L in enumerate(layers):
        ctl.progress(0.2 * li / nl, "voxelizing ground")
        amps.append((L.jit, L.patch, L.checker))
        if L.deck:
            continue
        if L.levels is not None:
            for poly, lv in zip(L.polys, L.levels):
                ix, iz = cells_in_geom(poly, g, win)
                if len(ix):
                    r, c = iz - wz0, ix - wx0
                    col[r, c] = L.rgb
                    sty[r, c] = li + 1
                    mat[r, c] = L.mat
                    wl[r, c] = lv
        else:
            ix, iz = cells_in_geom(shapely.union_all(L.polys), g, win)
            if len(ix):
                r, c = iz - wz0, ix - wx0
                col[r, c] = L.rgb
                sty[r, c] = li + 1
                mat[r, c] = L.mat
                wl[r, c] = NO_WATER
    drop = max(1, int(np.ceil(cfg.water_drop_m / g.vs - 1e-9)))
    wl = np.where(wl == FOLLOW, gh - drop, wl)
    dthick = max(1, int(np.ceil(cfg.bridge_deck_thickness_m / g.vs - 1e-9)))
    dclear = max(1, int(np.ceil(cfg.bridge_min_clearance_m / g.vs - 1e-9)))
    for L in layers:  # water under a bridge deck never reaches it (keeps clear air beneath the deck)
        if L.deck and L.levels is not None:
            for poly, lv in zip(L.polys, L.levels):
                ix, iz = cells_in_geom(poly, g, win)
                if len(ix):
                    r, c = iz - wz0, ix - wx0
                    cur = wl[r, c]
                    wl[r, c] = np.where(cur != NO_WATER, np.minimum(cur, lv - dthick - dclear), cur)
    water = wl != NO_WATER
    top = np.where(water, wl, gh).astype(np.int32)
    pad = ((wz0 - (iz0 - 1), (iz1 + 1) - wz1), (wx0 - (ix0 - 1), (ix1 + 1) - wx1))
    if any(p for pr in pad for p in pr):
        top = np.pad(top, pad, mode="edge")
    t = top[1:-1, 1:-1]
    nmin = np.minimum(np.minimum(top[:-2, 1:-1], top[2:, 1:-1]), np.minimum(top[1:-1, :-2], top[1:-1, 2:]))
    cz, cx = iz0 - wz0, ix0 - wx0
    cw = water[cz:cz + nzt, cx:cx + nxt]
    cap = max(1, int(np.ceil(cfg.skirt_max_depth_m / g.vs)))
    nsk = np.minimum(np.maximum(t - (nmin + 1), 0), cap)
    nsk = np.where(cw, np.maximum(nsk, 1), nsk)

    ixg = np.arange(ix0, ix1, dtype=np.int64)[None, :]
    izg = np.arange(iz0, iz1, dtype=np.int64)[:, None]
    am = np.array(amps, np.float64)[sty[cz:cz + nzt, cx:cx + nxt]]  # (nzt, nxt, 3)
    f = brightness(ixg, izg, am[..., 0], am[..., 1], am[..., 2], g.vs)
    top_rgb = np.clip(np.rint(col[cz:cz + nzt, cx:cx + nxt].astype(np.float64) * f[..., None]), 0, 255).astype(np.uint8)
    top_mat = mat[cz:cz + nzt, cx:cx + nxt]

    X0 = np.broadcast_to(ixg, (nzt, nxt)).astype(np.int32)
    Z0 = np.broadcast_to(izg, (nzt, nxt)).astype(np.int32)
    xs = [X0.reshape(-1)]
    ys = [t.reshape(-1)]
    zs = [Z0.reshape(-1)]
    cs = [pack(top_rgb, top_mat.reshape(-1))]

    ctl.progress(0.19, "ground skirts")
    n = nsk.reshape(-1).astype(np.int64)
    tot = int(n.sum())
    if max_vox is not None and tot + nxt * nzt > max_vox:  # before allocating the skirt arrays
        raise PipelineError("VOXEL_LIMIT", f"Voxel count exceeds maxVoxels ({max_vox}); "
                            "reduce the area or increase voxelSize")
    if tot:
        idx = np.repeat(np.arange(n.size), n)
        k = np.arange(tot) - np.repeat(np.cumsum(n) - n, n)
        wflat = cw.reshape(-1)[idx]
        base = np.where(wflat[:, None], np.array(cfg.water_bed_color, np.float64),
                        np.array(cfg.dirt_color, np.float64))
        fj = brightness(X0.reshape(-1)[idx], Z0.reshape(-1)[idx], 5.0, 0.0, 0.0, g.vs) * \
            np.where(k > 0, 0.92, 1.0)
        rgb = np.clip(np.rint(base * fj[:, None]), 0, 255).astype(np.uint8)
        xs.append(X0.reshape(-1)[idx])
        ys.append(t.reshape(-1)[idx] - 1 - k.astype(np.int32))
        zs.append(Z0.reshape(-1)[idx])
        cs.append(pack(rgb, MAT_GROUND))
    thick = max(1, int(np.ceil(cfg.bridge_deck_thickness_m / g.vs - 1e-9)))
    for li, L in enumerate(layers):  # bridge decks: lifted road voxels, nothing carved underneath
        if not L.deck or L.levels is None:
            continue
        jit, patch, chk = amps[li + 1]
        for poly, lv in zip(L.polys, L.levels):
            ix, iz = cells_in_geom(poly, g, core)
            if not len(ix):
                continue
            f = brightness(ix.astype(np.int64), iz.astype(np.int64), jit, patch, chk, g.vs)
            rgb = np.clip(np.rint(np.array(L.rgb, np.float64) * f[:, None]), 0, 255).astype(np.uint8)
            for k in range(thick):
                xs.append(ix.astype(np.int32))
                ys.append(np.full(len(ix), lv - k, np.int32))
                zs.append(iz.astype(np.int32))
                cs.append(pack(rgb if k == 0 else (rgb * 0.8).astype(np.uint8), L.mat))
    return (np.concatenate(xs), np.concatenate(ys).astype(np.int32), np.concatenate(zs),
            np.concatenate(cs))


def _sample_pts(geom, step: float, max_axis: int = 60):
    """Regular sample points inside ``geom`` (any polygonal geometry); falls back to vertices + a
    representative point for slivers. Returns (xs, ys) or None."""
    if geom is None or geom.is_empty:
        return None
    minx, miny, maxx, maxy = geom.bounds
    step = max(step, max(maxx - minx, maxy - miny) / max_axis)
    xs = np.arange(minx + step / 2, maxx, step)
    ys = np.arange(miny + step / 2, maxy, step)
    if len(xs) and len(ys):
        gx, gy = np.meshgrid(xs, ys)
        m = shapely.contains_xy(geom, gx.ravel(), gy.ravel())
        if m.sum() >= 3:
            return gx.ravel()[m], gy.ravel()[m]
    c = shapely.get_coordinates(geom)[:64]
    rp = geom.representative_point()
    return np.append(c[:, 0], rp.x), np.append(c[:, 1], rp.y)


def water_levels(layer: Layer, terrain: Optional[Terrain], g: Grid, cfg: Config) -> List[int]:
    """Water-surface voxel height per polygon (or FOLLOW for sloping water).

    Only the part of a polygon that lies inside the DEM lattice is sampled (the lattice clamps outside its
    window, which would read garbage for big lakes). The surface is the ``q`` percentile of the terrain under
    the polygon, but always 1..water_max_below_m below the BANK level = 25th percentile of the terrain in a
    ring just outside the polygon, so water sits just under its banks."""
    drop = max(1, int(np.ceil(cfg.water_drop_m / g.vs - 1e-9)))
    below = max(drop, int(np.ceil(cfg.water_max_below_m / g.vs - 1e-9)))
    n = len(layer.polys)
    if terrain is None:
        return [-drop] * n
    quants = layer.quant or [25.0] * n
    sp, datum = terrain.sp, terrain.datum
    nb, na = terrain.z.shape
    win = shapely.box((terrain.a0 + 1) * sp, (terrain.b0 + 1) * sp,
                      (terrain.a0 + na - 2) * sp, (terrain.b0 + nb - 2) * sp)
    ring_w = max(3.0 * sp, 6.0)
    big = win.buffer(ring_w + sp)
    flat_tol = max(cfg.water_flat_tol_m, 2.0 * g.vs)
    vox = lambda m: int(np.rint((m - datum) / g.vs))
    out: List[int] = []
    for poly, q in zip(layer.polys, quants):
        local = poly.intersection(big)
        inner_g = local.intersection(win)
        pts = _sample_pts(inner_g, max(sp, g.vs))
        if pts is None:  # polygon outside the lattice: use the nearest lattice value
            rp = poly.representative_point()
            out.append(vox(float(terrain.metres(rp.x, rp.y))) - drop)
            continue
        z = terrain.metres(pts[0], pts[1])
        if float(np.percentile(z, 95) - np.percentile(z, 5)) > flat_tol:
            out.append(FOLLOW)  # sloping water: carve a trench that follows the ground
            continue
        lv = vox(float(np.percentile(z, q)))
        rpts = _sample_pts(local.buffer(ring_w).difference(local).intersection(win), max(sp / 2.0, g.vs))
        if rpts is not None:
            bank = vox(float(np.percentile(terrain.metres(rpts[0], rpts[1]), 25)))
            lv = int(np.clip(min(lv, bank - drop), bank - below, bank - drop))
        else:
            lv -= drop
        out.append(lv)
    return out


def deck_levels(layer: Layer, terrain: Optional[Terrain], g: Grid, cfg: Config) -> List[int]:
    """Deck voxel height per bridge piece: ground height at the way's two ends interpolated linearly along
    the way (a flat deck per ~8 m piece), never below the lower end."""
    out: List[int] = []
    datum = terrain.datum if terrain is not None else 0.0
    for (ea, na, eb, nb, t) in layer.meta or []:
        if terrain is None:
            out.append(0)
            continue
        za = float(terrain.metres(ea, na))
        zb = float(terrain.metres(eb, nb))
        z = za + (zb - za) * t
        out.append(int(np.rint((z - datum) / g.vs)))
    return out


def clear_decks_over_water(layers: List[Layer], g: Grid, cfg: Config) -> None:
    """Raise any bridge piece whose underside would not clear the (flat) water it crosses by
    bridge_min_clearance_m (>= 1 voxel of air between the water surface and the deck)."""
    wp, wl = [], []
    for L in layers:
        if L.levels is not None and not L.deck:
            for poly, lv in zip(L.polys, L.levels):
                if lv != FOLLOW:
                    wp.append(poly)
                    wl.append(lv)
    if not wp:
        return
    tree = shapely.STRtree(wp)
    thick = max(1, int(np.ceil(cfg.bridge_deck_thickness_m / g.vs - 1e-9)))
    clear = max(1, int(np.ceil(cfg.bridge_min_clearance_m / g.vs - 1e-9)))
    for L in layers:
        if not L.deck or L.levels is None:
            continue
        for i, poly in enumerate(L.polys):
            hit = tree.query(poly, predicate="intersects")
            if len(hit):
                L.levels[i] = max(L.levels[i], max(wl[int(k)] for k in hit) + thick + clear)
