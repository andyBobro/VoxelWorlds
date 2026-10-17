"""Repaint ONE wall of a voxelised building from a photo-derived FacadeSpec (contract).

The wall is the footprint edge ``ring[i] -> ring[i+1]`` of the CCW-oriented outer ring. Seen from outside the
wall, ``u`` grows ring[i] -> ring[i+1] (left to right); ``v`` is metres up from the lowest wall voxel. The spec
always spans the FULL edge (spec coordinates are rescaled to the real wall size).

The wall is rebuilt as a small slab of ``K`` voxel layers behind the original 1-voxel shell so that features have
depth: window recesses (glass set back), frames and sills, floor bands and cornice (flush or 1 voxel proud), a
door recess with a raised threshold and a step in front (fine voxel sizes). Everything is a pure function of
(building id, spec, grid), so the result is deterministic."""
from __future__ import annotations

import json
import math
import zlib
from types import SimpleNamespace
from typing import List, Optional, Tuple

import numpy as np
import shapely
from shapely.geometry import Polygon

from ..protocol import PipelineError
from .roofdetail import hnoise, key_hash

SLAB = (176, 172, 164)
DOOR_COLOURS = [(92, 64, 44), (70, 52, 42), (60, 80, 70), (110, 40, 36), (50, 56, 70)]


def spec_seed(building_id: str, spec: dict) -> int:
    """Deterministic seed from the building id and the spec content."""
    blob = building_id + "|" + json.dumps(spec, sort_keys=True, separators=(",", ":"))
    return zlib.crc32(blob.encode("utf-8")) & 0xFFFFFFFF


def _num(v, name: str, lo: float = -1e6, hi: float = 1e6) -> float:
    try:
        f = float(v)
    except Exception:
        raise PipelineError("BAD_REQUEST", f"facade spec: {name} must be a number")
    if not math.isfinite(f) or not (lo <= f <= hi):
        raise PipelineError("BAD_REQUEST", f"facade spec: {name} out of range")
    return f


def _colour(v, name: str, default):
    if v is None:
        return np.asarray(default, np.float64)
    if not isinstance(v, (list, tuple)) or len(v) != 3:
        raise PipelineError("BAD_REQUEST", f"facade spec: {name} must be [r, g, b]")
    return np.asarray([_num(c, name, 0, 255) for c in v], np.float64)


MATERIALS = {"plaster", "brick", "stone", "concrete", "glass", "wood", "metal"}
MAX_ITEMS = 5000


def coerce_spec(spec) -> dict:
    """Validated copy of a FacadeSpec with plain Python floats; PipelineError(BAD_REQUEST) on wrong shapes."""
    if not isinstance(spec, dict):
        raise PipelineError("BAD_REQUEST", "facade spec must be an object")
    out = dict(spec)
    for k in ("wallWidthM", "wallHeightM"):
        out[k] = _num(spec.get(k, 1.0) if spec.get(k) is not None else 1.0, k, 0.1, 1000.0)
    fl = spec.get("floorLinesV", [])
    if not isinstance(fl, (list, tuple)) or len(fl) > MAX_ITEMS:
        raise PipelineError("BAD_REQUEST", "facade spec: floorLinesV must be a list of numbers")
    out["floorLinesV"] = [_num(v, "floorLinesV", -1e6, 1e6) for v in fl]
    for k in ("windows", "doors"):
        items = spec.get(k, [])
        if not isinstance(items, (list, tuple)) or len(items) > MAX_ITEMS:
            raise PipelineError("BAD_REQUEST", f"facade spec: {k} must be a list of {{u,v,w,h}}")
        rs = []
        for r in items:
            if not isinstance(r, dict):
                raise PipelineError("BAD_REQUEST", f"facade spec: {k} entries must be objects")
            rs.append({c: _num(r.get(c), f"{k}.{c}") for c in ("u", "v", "w", "h")})
        out[k] = rs
    out["wallColour"] = _colour(spec.get("wallColour"), "wallColour", (200, 190, 170)).tolist()
    out["trimColour"] = _colour(spec.get("trimColour"), "trimColour", np.array(out["wallColour"]) * 0.85).tolist()
    out["glassColour"] = _colour(spec.get("glassColour"), "glassColour", (62, 84, 108)).tolist()
    m = spec.get("material")
    out["material"] = m if isinstance(m, str) and m in MATERIALS else "plaster"
    return out


def _rects(items, su: float, sv: float, L: float, H: float, vs: float):
    out = []
    for r in items or []:
        try:
            u0, v0 = float(r["u"]) * su, float(r["v"]) * sv
            u1, v1 = u0 + float(r["w"]) * su, v0 + float(r["h"]) * sv
        except Exception:
            continue
        u0, v0, u1, v1 = max(0.0, u0), max(0.0, v0), min(L, u1), min(H, v1)
        if u1 - u0 >= 0.5 * vs and v1 - v0 >= 0.5 * vs:
            out.append((u0, v0, u1, v1))
    return out


def _seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    l2 = np.maximum(dx * dx + dy * dy, 1e-12)
    t = np.clip(((px - ax) * dx + (py - ay) * dy) / l2, 0.0, 1.0)
    return np.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _texture(mat: str, u: np.ndarray, v_row: np.ndarray, x, y, z, vs: float, seed: int) -> np.ndarray:
    """Brightness factor (quantised to 1/50) per (cell,row) element - 1-D inputs already broadcast."""
    kc = max(1, int(round(0.5 / vs)))
    n = hnoise(x // kc, y // kc, z // kc, seed & 0xFFFF)
    f = 1.0 + 0.02 * np.round(4 * (n - 0.5))
    if mat == "brick":
        if vs <= 0.1:
            course = np.floor(v_row / 0.0825).astype(np.int64)
            f = f * np.where(course % 2 == 0, 1.0, 0.96)
        else:
            f = f * np.where(np.floor(v_row / vs).astype(np.int64) % 2 == 0, 1.0, 0.97)
    elif mat == "stone":
        bh, bw = 0.6, 1.2
        row = np.floor(v_row / bh).astype(np.int64)
        col = np.floor((u + (row % 2) * 0.6) / bw).astype(np.int64)
        f = f * (1.0 + 0.02 * np.round(4 * (hnoise(col, row, 7, 9) - 0.5)))
        if vs <= 0.25:
            edge = (np.abs((v_row / bh) - np.round(v_row / bh)) * bh < vs * 0.5) | \
                   (np.abs(((u + (row % 2) * 0.6) / bw) - np.round((u + (row % 2) * 0.6) / bw)) * bw < vs * 0.5)
            f = np.where(edge, f * 0.93, f)
    elif mat == "wood":
        f = f * np.where(np.floor(u / max(0.15, vs)).astype(np.int64) % 2 == 0, 1.0, 0.96)
    elif mat == "metal":
        f = f * np.where(np.floor(u / max(0.2, vs)).astype(np.int64) % 2 == 0, 1.0, 0.95)
    elif mat == "concrete":
        f = f * np.where(np.floor(u / 3.0) != np.floor((u - vs) / 3.0), 0.94, 1.0)
    return np.round(f * 50.0) / 50.0


def paint_edge(poly: Polygon, edge: int, spec: dict, grid, base_y: int, eave_y: int, building_id: str,
               check=None, chunk_elems: int = 2_000_000, max_elems: int = 60_000_000):
    """Build the replacement slab for one wall.

    Returns None when the edge is unusable, else a SimpleNamespace:
      remove_cells  (ix, iz) arrays of the slab cells whose original wall voxels (y < eave_y) must be removed
      x, y, z, rgb  new voxels (rgb uint8 (n,3))
      windows, doors  number of openings actually painted
      openings      list of dict(edge, kind, x0, x1, z0, z1, y0, y1) voxel boxes (grid indices, exclusive upper)
      K             slab thickness in voxels
    The slab is evaluated in strips of cells (about ``chunk_elems`` cell x row elements, ``check()`` is called
    between strips); the result does not depend on the strip size. ``max_elems`` bounds cell x row elements
    (PipelineError VOXEL_LIMIT). Bad spec shapes raise PipelineError BAD_REQUEST."""
    spec = coerce_spec(spec)
    vs = grid.vs
    check = check or (lambda: None)
    co = np.asarray(poly.exterior.coords)[:-1]
    n = len(co)
    if not (0 <= edge < n):
        return None
    p0, p1 = co[edge], co[(edge + 1) % n]
    d = p1 - p0
    L = float(np.hypot(*d))
    Hw = (eave_y - base_y - 1) * vs
    if L < max(0.5, 2 * vs) or Hw < 2 * vs:
        return None
    t = d / L
    nrm = np.array([t[1], -t[0]])  # outward for a CCW ring
    seed = spec_seed(building_id, spec)

    su = L / max(float(spec.get("wallWidthM") or L), 1e-6)
    sv = Hw / max(float(spec.get("wallHeightM") or Hw), 1e-6)
    wins = _rects(spec.get("windows"), su, sv, L, Hw, vs)
    doors = _rects(spec.get("doors"), su, sv, L, Hw, vs)
    doors = [(a, 0.0, b, min(Hw, c)) for (a, _, b, c) in doors]
    lines = [float(l) * sv for l in (spec.get("floorLinesV") or []) if 0 < float(l) * sv < Hw - 0.5]
    wall_rgb = np.asarray(spec.get("wallColour") or (200, 190, 170), np.float64)
    trim_rgb = np.asarray(spec.get("trimColour") or wall_rgb * 0.85, np.float64)
    glass_rgb = np.asarray(spec.get("glassColour") or (62, 84, 108), np.float64)
    mat = spec.get("material") or "plaster"
    door_rgb = np.asarray(DOOR_COLOURS[int(key_hash(building_id, 301) * len(DOOR_COLOURS)) % len(DOOR_COLOURS)],
                          np.float64)

    K = max(2, int(math.ceil(0.25 / vs)))
    R = min(max(1, int(round(0.12 / vs))), K - 1)
    if doors:
        K = max(K, R + 2)
    proud = vs <= 0.3
    raise_door = vs <= 0.25
    F = max(0.07, 0.9 * vs)
    jmax = 1 + (int(round(0.4 / vs)) if (raise_door and doors) else 0)

    # ---- candidate cells around the edge
    reach = (K + jmax + 2) * vs
    xs = np.array([p0[0], p1[0]]); ys = np.array([p0[1], p1[1]])
    ix0 = int(math.floor((xs.min() - reach - grid.e0) / vs)); ix1 = int(math.ceil((xs.max() + reach - grid.e0) / vs))
    iz0 = int(math.floor((grid.n0 - ys.max() - reach) / vs)); iz1 = int(math.ceil((grid.n0 - ys.min() + reach) / vs))
    ix0, iz0 = max(0, ix0), max(0, iz0)
    ix1, iz1 = min(grid.nx, ix1), min(grid.nz, iz1)
    if ix1 <= ix0 or iz1 <= iz0:
        return None
    gi, gj = np.meshgrid(np.arange(ix0, ix1), np.arange(iz0, iz1))
    gi, gj = gi.ravel(), gj.ravel()
    E, N = grid.centers_e(gi), grid.centers_n(gj)
    u = (E - p0[0]) * t[0] + (N - p0[1]) * t[1]
    dep = (E - p0[0]) * nrm[0] + (N - p0[1]) * nrm[1]
    m = (u >= 0) & (u < L) & (dep >= -K * vs) & (dep < jmax * vs)
    gi, gj, E, N, u, dep = gi[m], gj[m], E[m], N[m], u[m], dep[m]
    if len(gi) == 0:
        return None
    # nearest outline segment must be this edge
    dist_e = _seg_dist(E, N, p0[0], p0[1], p1[0], p1[1])
    best = np.full(len(E), np.inf)
    for k in range(n):
        check()
        if k == edge:
            continue
        best = np.minimum(best, _seg_dist(E, N, co[k][0], co[k][1], co[(k + 1) % n][0], co[(k + 1) % n][1]))
    mine = dist_e <= best + 1e-9
    shell = Polygon(co)
    inside_poly = shapely.contains_xy(shell, E, N)
    keep = mine & np.where(dep < 0, inside_poly, ~inside_poly)
    gi, gj, u, dep = gi[keep], gj[keep], u[keep], dep[keep]
    if len(gi) == 0:
        return None
    layer = np.where(dep < 0, np.floor(-dep / vs).astype(np.int64), -(np.floor(dep / vs).astype(np.int64) + 1))
    ncell = len(gi)
    ny = eave_y - base_y - 1
    rows = np.arange(ny)
    vrow = (rows + 0.5) * vs

    if ncell * ny > max_elems:
        raise PipelineError("VOXEL_LIMIT", f"Facade slab needs {ncell * ny} cell-rows (limit {max_elems}); "
                            "increase voxelSize")
    rows = np.arange(ny)
    vrow = (rows + 0.5) * vs

    openings = [("window", r) for r in wins] + [("door", r) for r in doors]

    def _strip(gi, gj, u, layer):
        # ---- 2-D feature maps over (cell, row)
        def inrect(r, uu, vv):
            return (uu[:, None] >= r[0]) & (uu[:, None] < r[2]) & (vv[None, :] >= r[1]) & (vv[None, :] < r[3])
        ncell = len(gi)
        shape = (ncell, ny)
        W_in = np.zeros(shape, bool); W_fr = np.zeros(shape, bool); SILL = np.zeros(shape, bool)
        D_in = np.zeros(shape, bool); D_fr = np.zeros(shape, bool); STEP = np.zeros(shape, bool)
        for r in wins:
            full = inrect(r, u, vrow)
            shr = (r[0] + F, r[1] + F, r[2] - F, r[3] - F)
            if shr[2] - shr[0] >= vs and shr[3] - shr[1] >= vs:
                gl = inrect(shr, u, vrow)
            else:
                gl = full
            W_in |= gl
            W_fr |= full & ~gl
            if r[2] - r[0] > 1.4 and (shr[2] - shr[0]) > 3 * F:  # mullion
                mid = 0.5 * (r[0] + r[2])
                W_fr |= full & (np.abs(u[:, None] - mid) < max(0.5 * F, 0.5 * vs))
                W_in &= ~(np.abs(u[:, None] - mid) < max(0.5 * F, 0.5 * vs))
            SILL |= (u[:, None] >= r[0] - F) & (u[:, None] < r[2] + F) & (vrow[None, :] < r[1]) & \
                    (vrow[None, :] >= r[1] - vs)
        for r in doors:
            full = inrect(r, u, vrow)
            shr = (r[0] + F, r[1], r[2] - F, r[3] - F)
            gl = inrect(shr, u, vrow) if shr[2] - shr[0] >= vs else full
            D_in |= gl
            D_fr |= full & ~gl
            if raise_door:
                STEP |= (u[:, None] >= r[0] - 0.2) & (u[:, None] < r[2] + 0.2) & (rows[None, :] == 0)
        OPEN = W_in | D_in
        FRAME = W_fr | D_fr
        band = np.zeros(ny, bool)
        bw = max(vs, 0.18)
        for l in lines:
            band |= np.abs(vrow - l) < bw / 2.0
        CORN = (vrow >= Hw - max(vs, 0.35)) & (Hw > 3.0)
        band &= ~CORN
        PLINTH = vrow < max(vs, 0.5)
        BAND = np.broadcast_to(band[None, :], shape) & ~OPEN & ~FRAME
        CORNM = np.broadcast_to(CORN[None, :], shape) & ~OPEN & ~FRAME
        PLM = np.broadcast_to(PLINTH[None, :], shape) & ~OPEN & ~FRAME & ~D_fr

        check()
    # ---- evaluate layers
        X = np.repeat(gi[:, None], ny, 1); Z = np.repeat(gj[:, None], ny, 1)
        Y = np.broadcast_to((base_y + 1 + rows)[None, :], shape)
        Uu = np.repeat(u[:, None], ny, 1); Vv = np.broadcast_to(vrow[None, :], shape)
        tex = _texture(mat, Uu, Vv, X, Y, Z, vs, seed)
        base_col = wall_rgb[None, None, :] * tex[..., None]
        lay = np.repeat(layer[:, None], ny, 1)
        inner = lay >= 0
        outer = ~inner

        solid = np.zeros(shape, bool)
        col = np.broadcast_to(base_col, shape + (3,)).copy()
        # inside layers: default solid wall
        solid |= inner
        # window: air in front of the glass, glass at k == R
        win_air = W_in & inner & (lay < R)
        solid &= ~win_air
        gl_here = W_in & inner & (lay == R)
        col[gl_here] = glass_rgb
        # door: air in front of the leaf (k < R+1), leaf at k == R+1
        dr_air = D_in & inner & (lay <= R)
        if raise_door:
            dr_air &= (rows[None, :] >= 1)  # threshold row stays solid
        solid &= ~dr_air
        leaf = D_in & inner & (lay == R + 1) & (rows[None, :] >= (1 if raise_door else 0))
        col[leaf] = door_rgb
        # frames / bands / cornice / plinth colour on the outer shell layers
        fr_here = FRAME & inner & (lay <= R + (1 if doors else 0))
        col[fr_here] = trim_rgb
        col[BAND & inner & (lay == 0)] = trim_rgb
        col[CORNM & inner & (lay == 0)] = np.clip(trim_rgb * 1.05, 0, 255)
        col[PLM & inner & (lay == 0)] = wall_rgb * 0.78
        col[SILL & inner & (lay == 0)] = trim_rgb
        col[(STEP & inner & (lay == 0))] = SLAB
        # outside layers (protrusions)
        if proud:
            j1 = outer & (lay == -1)
            for mask in (SILL, BAND, CORNM):
                sel = mask & j1
                solid |= sel
                col[sel] = trim_rgb
        if raise_door and doors:
            j = -lay
            step = STEP & outer & (j >= 1) & (j <= jmax - 0)
            solid |= step
            col[step] = SLAB

        return X[solid].astype(np.int32), Y[solid].astype(np.int32), Z[solid].astype(np.int32), \
            np.clip(col[solid], 0, 255).astype(np.uint8)

    step = max(1, chunk_elems // max(1, ny))
    pieces = []
    for c0 in range(0, len(gi), step):
        if check is not None:
            check()
        sl = slice(c0, c0 + step)
        pieces.append(_strip(gi[sl], gj[sl], u[sl], layer[sl]))
        out = SimpleNamespace(
        remove_cells=(gi[layer >= 0].astype(np.int32), gj[layer >= 0].astype(np.int32)),
        x=np.concatenate([p[0] for p in pieces]), y=np.concatenate([p[1] for p in pieces]),
        z=np.concatenate([p[2] for p in pieces]), rgb=np.concatenate([p[3] for p in pieces]),
        windows=len(wins), doors=len(doors), K=K, openings=[])
    # voxel boxes of the openings (grid indices) for the interior agent
    for kind, r in openings:
        check()
        em = (u >= r[0]) & (u < r[2]) & (layer >= 0)
        if not em.any():
            continue
        ys_ = base_y + 1 + int(math.floor(r[1] / vs)), base_y + 1 + int(math.ceil(r[3] / vs))
        out.openings.append(dict(edge=edge, kind=kind, x0=int(gi[em].min()), x1=int(gi[em].max()) + 1,
                                 z0=int(gj[em].min()), z1=int(gj[em].max()) + 1, y0=ys_[0], y1=ys_[1]))
    return out
