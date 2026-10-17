"""Roof-level detail: parapets, rooftop equipment, skylights, ridge caps, chimneys, dormers and roof texture.

Everything is a pure function of the building's own global voxel coordinates and its key seed (hash based, no
RNG state), so tiles and workers agree. Detail only exists where it is at least one voxel big, so nothing is
sub-voxel at coarse sizes (`Config.roof_details`, voxel size <= `DETAIL_MAX_VS`)."""
from __future__ import annotations

import math
import zlib
from typing import Optional, Tuple

import numpy as np

DETAIL_MAX_VS = 1.0

K_ROOF, K_PARAPET, K_COPING, K_CHIMNEY, K_RIDGE, K_EQUIP, K_BULK, K_GLASS = 0, 1, 2, 3, 4, 5, 6, 7
K_DORMER_WALL, K_DORMER_WIN, K_DORMER_ROOF, K_CHIMCAP = 8, 9, 10, 11

BRICK = (150, 84, 64)
CHIM_CAP = (62, 58, 58)
EQUIP = [(150, 154, 158), (170, 172, 172), (128, 134, 140), (186, 184, 176)]
SKY_GLASS = (92, 136, 164)


def hnoise(x, y, z, salt: int = 0) -> np.ndarray:
    """Deterministic uniform [0,1) per integer coordinate triple (vectorised)."""
    v = (np.asarray(x, np.int64) * 73856093) ^ (np.asarray(y, np.int64) * 19349663) ^ \
        (np.asarray(z, np.int64) * 83492791) ^ _salt(salt)
    v &= 0xFFFFFFFF
    v ^= v >> 13
    v = (v * 0x5BD1E995) & 0xFFFFFFFF
    v ^= v >> 15
    return (v & 0xFFFF).astype(np.float64) / 65536.0


_SALTS: dict = {}


def _salt(salt: int) -> int:
    v = _SALTS.get(salt)
    if v is None:
        v = _SALTS[salt] = zlib.crc32(f"salt:{int(salt)}".encode("ascii")) & 0xFFFFFFFF
    return v


def key_hash(key: str, salt: int = 0) -> float:
    """Uniform [0,1) from the building key and a salt; salts give independent values (crc32 of the pair)."""
    return (zlib.crc32(f"{key}:{salt}".encode("utf-8")) & 0xFFFFFF) / float(1 << 24)


def _vox(m: float, vs: float) -> int:
    return max(1, int(round(m / vs)))


def _erode(m: np.ndarray, k: int) -> np.ndarray:
    for _ in range(k):
        n = m.copy()
        n[1:-1, 1:-1] = m[1:-1, 1:-1] & m[:-2, 1:-1] & m[2:, 1:-1] & m[1:-1, :-2] & m[1:-1, 2:]
        n[0, :] = n[-1, :] = False
        n[:, 0] = n[:, -1] = False
        m = n
        if not m.any():
            break
    return m


def _append(b, x, y, z, k) -> None:
    x = np.asarray(x, np.int32)
    if len(x) == 0:
        return
    b.rx = np.concatenate([b.rx, x])
    b.ry = np.concatenate([b.ry, np.asarray(y, np.int32)])
    b.rz = np.concatenate([b.rz, np.asarray(z, np.int32)])
    b.rk = np.concatenate([b.rk, np.full(len(x), k, np.int8)])


def _box(ox: int, oz: int, w: int, d: int, y0: int, h: int):
    xs, zs, ys = np.meshgrid(np.arange(ox, ox + w), np.arange(oz, oz + d), np.arange(y0, y0 + h), indexing="ij")
    return xs.ravel(), ys.ravel(), zs.ravel()


def add_extras(b, cfg, vs: float, ix, iz, r, eave: int, m: np.ndarray, x0: int, z0: int, is_wall,
               ce=None, cn=None) -> None:
    """Append parapets / equipment / chimneys / ridge caps / dormers to ``b`` (arrays rx,ry,rz,rk).
    m: padded footprint mask (h, w) with cell (iz,ix) at [iz-z0+1, ix-x0+1]; r: roof height (voxels) per cell."""
    if vs > DETAIL_MAX_VS or not getattr(cfg, "roof_details", True) or b.open_structure:
        return
    shape = b.roof.shape
    minor = b.kind == "minor"
    area = float(b.poly.area)
    key = b.key
    if shape == "flat" and not minor and area >= 20.0:
        _flat_extras(b, cfg, vs, ix, iz, eave, m, x0, z0, is_wall, area)
    elif shape in ("gabled", "hipped", "pyramidal", "skillion") and b.rmax_v >= 1:
        _pitched_extras(b, cfg, vs, ix, iz, r, eave, m, x0, z0, area, shape, minor)
        if shape == "gabled" and not minor and ce is not None:
            _dormers(b, vs, ix, iz, r, eave, ce, cn, area)


def _pick(cand_z, cand_x, key: str, salt: int, n: int, spacing_cells: int):
    """Greedy deterministic selection of up to n well-spaced cells by hash rank."""
    if len(cand_x) == 0 or n <= 0:
        return []
    u = hnoise(cand_x, cand_z, salt, int(key_hash(key, salt) * 1e6))
    order = np.argsort(u, kind="stable")
    out = []
    for j in order[: 4000]:
        cx, cz = int(cand_x[j]), int(cand_z[j])
        if all(max(abs(cx - a), abs(cz - c)) >= spacing_cells for a, c in out):
            out.append((cx, cz))
            if len(out) >= n:
                break
    return out


def _flat_extras(b, cfg, vs, ix, iz, eave, m, x0, z0, is_wall, area) -> None:
    key = b.key
    # ---- parapet around the roof edge
    if key_hash(key, 11) < 0.88 and b.height_m >= 4.0:
        ph_m = (0.4, 0.6, 0.8)[int(key_hash(key, 12) * 3) % 3]
        ph = _vox(ph_m, vs)
        wx, wz = ix[is_wall], iz[is_wall]
        if len(wx):
            for h in range(ph):
                _append(b, wx, np.full(len(wx), eave + 1 + h), wz, K_COPING if h == ph - 1 else K_PARAPET)
    # ---- rooftop equipment (interior cells only, clear of the parapet)
    margin = _vox(1.3, vs)
    units = []
    n_hvac = int(min(8, area / 220.0)) + (1 if area >= 90 else 0)
    if b.height_m >= 14.0 and area >= 220.0:
        units.append(("bulk", _vox(2.2, vs), _vox(1.8, vs), _vox(2.2, vs), 1))
    if vs <= 0.75:
        units.append(("hvac", _vox(1.6, vs), _vox(1.0, vs), _vox(0.9, vs), n_hvac))
        if area >= 400:
            units.append(("vent", _vox(0.8, vs), _vox(0.8, vs), _vox(1.6, vs), 2))
    for ui, (name, w, d, h, n) in enumerate(units):
        if n <= 0:
            continue
        E = _erode(m.copy(), margin + max(w, d))
        zz, xx = np.nonzero(E)
        if len(xx) == 0:
            continue
        sp = max(w, d) * 2 + _vox(1.0, vs)
        for cx, cz in _pick(zz + z0 - 1, xx + x0 - 1, key, 20 + ui, n, sp):
            bx, by, bz = _box(cx, cz, w, d, eave + 1, h)
            _append(b, bx, by, bz, K_BULK if name == "bulk" else K_EQUIP)
    # ---- skylights: flush glass patches in the roof slab (recolour only)
    if area >= 150.0 and key_hash(key, 31) < 0.55 and len(b.rk):
        sw, sd = _vox(3.0, vs), _vox(2.0, vs)
        E = _erode(m.copy(), margin + max(sw, sd))
        zz, xx = np.nonzero(E)
        for cx, cz in _pick(zz + z0 - 1, xx + x0 - 1, key, 41, 2, 2 * max(sw, sd)):
            sel = (b.rx >= cx) & (b.rx < cx + sw) & (b.rz >= cz) & (b.rz < cz + sd) & (b.ry == eave)
            b.rk[sel] = K_GLASS


def _pitched_extras(b, cfg, vs, ix, iz, r, eave, m, x0, z0, area, shape, minor) -> None:
    key = b.key
    rmax = b.rmax_v
    # ---- real ridge cap: one voxel row on the ridge cells
    if shape in ("gabled", "hipped") and vs <= 0.5 and rmax >= 2:
        top = r >= rmax
        _append(b, ix[top], np.full(int(top.sum()), eave + rmax + 1), iz[top], K_RIDGE)
    # ---- chimneys
    if minor or area < 45.0 or b.kind in ("industrial",) or key_hash(key, 51) < 0.12:
        return
    nch = 1 + (1 if area >= 150.0 and key_hash(key, 52) < 0.7 else 0)
    cw = _vox(0.7, vs)
    hc = _vox(1.0, vs)
    E = _erode(m.copy(), max(1, _vox(0.9, vs)) + cw)
    ridge = np.zeros_like(m)
    ridge[iz - z0 + 1, ix - x0 + 1] = r >= max(1, rmax - 1)
    cand = E & ridge
    zz, xx = np.nonzero(cand)
    if len(xx) == 0:
        return
    R = np.full(m.shape, -1, np.int64)
    R[iz - z0 + 1, ix - x0 + 1] = r
    for cx, cz in _pick(zz + z0 - 1, xx + x0 - 1, key, 53, nch, _vox(4.0, vs)):
        for dx in range(cw):
            for dz in range(cw):
                lx, lz = cx + dx - x0 + 1, cz + dz - z0 + 1
                if not (0 <= lz < m.shape[0] and 0 <= lx < m.shape[1]) or R[lz, lx] < 0:
                    continue
                y0 = eave + int(R[lz, lx]) + 1
                y1 = eave + rmax + hc
                if y1 < y0:
                    continue
                ys = np.arange(y0, y1 + 1)
                n_ = len(ys)
                _append(b, np.full(n_, cx + dx), ys, np.full(n_, cz + dz), K_CHIMNEY)
                b.rk[-1] = K_CHIMCAP


def _dormers(b, vs, ix, iz, r, eave, ce, cn, area) -> None:
    """Box dormers with a window in the front face on the two slopes of a gabled roof (vs <= 0.5)."""
    sp = b.roof
    if vs > 0.5 or b.rmax_v * vs < 2.2 or b.kind in ("industrial",) or area < 70.0 or b.height_m < 6.0:
        return
    if key_hash(b.key, 61) < 0.35:
        return
    W = max(0.25, (sp.tmax - sp.tmin) / 2.0)
    tm = (sp.tmin + sp.tmax) / 2.0
    dx, dy = ce - sp.cx, cn - sp.cy
    rx_, ry_ = -sp.sy, sp.sx  # ridge axis = perpendicular to the slope axis (honours roof:direction / orientation)
    a_raw = dx * rx_ + dy * ry_
    amin, amax = float(a_raw.min()), float(a_raw.max())
    hl = (amax - amin) / 2.0
    if W < 3.0 or hl < 4.5:
        return
    a = a_raw - (amax + amin) / 2.0
    t = dx * sp.sx + dy * sp.sy - tm
    wd, dd = 1.5, 2.4
    hD = max(3, _vox(1.5, vs))
    spacing = 4.4
    n = int(min(4, max(1, (2 * hl - 5.0) // spacing + 1)))
    a0s = [-(n - 1) * spacing / 2.0 + i * spacing for i in range(n)]
    for sgn in (1.0, -1.0):
        if key_hash(b.key, 62 if sgn > 0 else 63) < 0.25:
            continue
        for i, a0 in enumerate(a0s):
            if key_hash(b.key, 70 + i + (10 if sgn < 0 else 0)) < 0.2:
                continue
            tt = sgn * t  # distance up the slope on this side (positive = this side)
            front = 0.55 * W
            body = (np.abs(a - a0) <= wd / 2.0) & (tt <= front) & (tt >= front - dd) & (r > 0)
            if not body.any():
                continue
            fr = body & (tt >= front - max(vs, 0.35))
            if not fr.any():
                continue
            rf = int(np.max(r[fr]))
            ytop = eave + rf + hD
            sel = np.flatnonzero(body)
            ys = eave + r[sel]  # roof surface top voxel of each cell
            cnt = np.maximum(ytop - ys, 0)
            rep = np.repeat(sel, cnt)
            if len(rep) == 0:
                continue
            st = np.cumsum(cnt) - cnt
            yy = ys[np.repeat(np.arange(len(sel)), cnt)] + 1 + (np.arange(len(rep)) - np.repeat(st, cnt))
            cx_, cz_ = ix[rep], iz[rep]
            kind = np.full(len(rep), -1, np.int8)
            top = yy == ytop
            kind[top] = K_DORMER_ROOF
            side = np.abs(a[rep] - a0) > wd / 2.0 - max(vs, 0.35)
            isfront = fr[rep]
            kind[~top & (side | isfront)] = K_DORMER_WALL
            ybase = ys[np.repeat(np.arange(len(sel)), cnt)] + 1
            sill = max(1, _vox(0.4, vs))
            wh = max(1, _vox(0.7, vs))
            win = isfront & ~top & ~side & (yy - np.min(ybase[isfront]) >= sill) & (yy - np.min(ybase[isfront]) < sill + wh)
            kind[win] = K_DORMER_WIN
            k = kind >= 0
            for kk in (K_DORMER_WALL, K_DORMER_WIN, K_DORMER_ROOF):
                mk = k & (kind == kk)
                _append(b, cx_[mk], yy[mk], cz_[mk], kk)


def _lin(rgb, f: np.ndarray) -> np.ndarray:
    return np.clip(np.asarray(rgb, np.float64)[None, :] * f[:, None], 0, 255)


def roof_colours(b, roof_rgb, wall_rgb, vs: float, seed: int) -> np.ndarray:
    """Per-voxel RGB (n,3) uint8 for b.rx/ry/rz, using b.rk kinds + tile courses / gravel texture."""
    n = len(b.rx)
    rk = b.rk if b.rk is not None and len(b.rk) == n else np.zeros(n, np.int8)
    x, y, z = b.rx.astype(np.int64), b.ry.astype(np.int64), b.rz.astype(np.int64)
    kc = max(1, int(round(0.5 / vs)))
    u = hnoise(x // kc, y // kc, z // kc, seed & 0xFFFF)
    blot = hnoise(x >> 3, 0, z >> 3, (seed >> 3) & 0xFFFF)
    fine_noise = 0.03 * np.round(4.0 * (u - 0.5)) if vs <= 0.35 else 0.0  # per-cell noise only at fine sizes
    noise = np.round((1.0 + fine_noise + 0.05 * (blot - 0.5)) * 50.0) / 50.0
    if b.roof.shape == "flat":
        rows = np.where(((x + z) >> 2) % 2 == 0, 0.97, 1.0) if vs <= 0.5 else 1.0
        f = noise * rows
    else:
        course = np.where(((y - b.eave_y) % 2) == 0, 0.95, 1.0) if vs <= 0.5 else 1.0
        f = noise * course
    out = _lin(roof_rgb, f)
    w = np.asarray(wall_rgb, np.float64)
    sel = rk == K_RIDGE
    if sel.any():
        out[sel] = np.asarray(roof_rgb, np.float64) * 0.78 * noise[sel][:, None]
    sel = rk == K_PARAPET
    if sel.any():
        out[sel] = w * 0.9 * noise[sel][:, None]
    sel = rk == K_COPING
    if sel.any():
        out[sel] = np.clip(w * 1.04 + 2, 0, 255) * noise[sel][:, None]
    sel = rk == K_BULK
    if sel.any():
        out[sel] = w * 0.88 * noise[sel][:, None]
    sel = rk == K_EQUIP
    if sel.any():
        pal = np.array(EQUIP, np.float64)
        pick = (hnoise(x[sel] >> 2, 0, z[sel] >> 2, 77) * len(pal)).astype(int) % len(pal)
        out[sel] = pal[pick] * noise[sel][:, None]
    sel = rk == K_GLASS
    if sel.any():
        out[sel] = np.asarray(SKY_GLASS, np.float64) * (0.92 + 0.16 * u[sel])[:, None]
    sel = rk == K_CHIMNEY
    if sel.any():
        out[sel] = np.asarray(BRICK, np.float64) * noise[sel][:, None]
    sel = rk == K_CHIMCAP
    if sel.any():
        out[sel] = np.asarray(CHIM_CAP, np.float64) * noise[sel][:, None]
    sel = rk == K_DORMER_WALL
    if sel.any():
        out[sel] = w * 1.0 * noise[sel][:, None]
    sel = rk == K_DORMER_WIN
    if sel.any():
        out[sel] = np.asarray((62, 84, 108), np.float64) * (0.9 + 0.2 * u[sel])[:, None]
    sel = rk == K_DORMER_ROOF
    if sel.any():
        out[sel] = np.asarray(roof_rgb, np.float64) * 0.9 * noise[sel][:, None]
    return np.clip(out, 0, 255).astype(np.uint8)
