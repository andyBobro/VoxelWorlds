"""Fine facade detail for wall voxels (only used at voxel sizes <= DETAIL_MAX_VS).

Facades are laid out per *wall run*: consecutive outline segments that continue (turning < ~30 degrees) are one
facade with a single arclength coordinate, so windows follow the real wall direction (diagonal and curved walls
get windows too, evenly spaced and symmetric between corner piers). Per building type: window size/spacing/
sill height, plinth, cornice, string course, ground-floor shopfronts + signboards, doors (OSM entrance=* nodes,
else one deterministic procedural door), shutters, sills and lintels, gable attic windows, balconies, glass
curtain walls (panes + mullions) and per-material wall texture (plaster noise, brick, stone blocks, timber
framing, planks, concrete panels, metal ribs). Party walls shared with a taller neighbour get no windows.

Everything is a pure function of the building's own global voxel coordinates + key seed, so tiles agree."""
from __future__ import annotations

from typing import Optional, Tuple

import numpy as np

from .roofdetail import hnoise, key_hash

DETAIL_MAX_VS = 1.0
DOOR_COLOURS = [(92, 64, 44), (70, 52, 42), (60, 80, 70), (110, 40, 36), (50, 56, 70)]
SLAB = (176, 172, 164)
RAIL = (70, 72, 78)
SHUTTER_COLOURS = [(70, 104, 76), (138, 60, 52), (112, 82, 58), (74, 92, 120), (200, 196, 184)]
SIGN_COLOURS = [(176, 44, 40), (34, 62, 118), (36, 36, 40), (208, 168, 62), (60, 110, 80)]
CURTAIN = (206, 196, 176)
FRAME = (226, 224, 216)
BEAM = (86, 60, 42)
TURN_COS = 0.866  # runs continue while consecutive segments turn by < 30 degrees
SHOP_TYPES = {"retail", "commercial", "supermarket", "kiosk", "shop", "mall", "restaurant", "cafe", "bank"}
STONE_MATS = {"stone", "sandstone", "limestone", "granite", "marble"}


def max_protrusion_m(vs: float) -> float:
    """Upper bound (m) on how far a building's voxels reach outside its footprint (balconies); tile task
    queries are inflated by this so every tile that sees such a voxel also receives the building."""
    return (max(1, int(round(0.8 / vs))) + 2) * vs


def _shade(rgb: Tuple[int, int, int], f: float) -> Tuple[int, int, int]:
    return tuple(int(np.clip(c * f, 0, 255)) for c in rgb)  # type: ignore


def _vox(m: float, vs: float) -> int:
    return max(1, int(round(m / vs)))


def _q(u: np.ndarray, levels: int, step: float) -> np.ndarray:
    """Quantised noise multiplier 1 + step*k, k in -levels/2..levels/2 (0 is always possible)."""
    return 1.0 + step * np.round(levels * (u - 0.5))


# ------------------------------------------------------------------ wall runs

class _Runs:
    """Outline segments grouped into facade runs with arclength coordinates."""

    def __init__(self, poly, party_h, party_lo=None):
        from .buildings import raw_segments
        p0, p1, nrm, L, ring = raw_segments(poly)
        S = len(L)
        self.p0, self.p1, self.nrm, self.L = p0, p1, nrm, L
        self.u = (p1 - p0) / np.maximum(L, 1e-9)[:, None]
        ph = np.zeros(S) if party_h is None or len(party_h) != S else np.asarray(party_h, float)
        run = np.zeros(S, np.int64)
        s0 = np.zeros(S)
        rid, acc = -1, 0.0
        for i in range(S):
            new = i == 0 or ring[i] != ring[i - 1] or (ph[i] > 0) != (ph[i - 1] > 0)
            if not new and L[i] > 0.4 and L[i - 1] > 0.4:
                new = float(np.dot(self.u[i], self.u[i - 1])) < TURN_COS
            if new:
                rid += 1
                acc = 0.0
            run[i], s0[i] = rid, acc
            acc += float(L[i])
        self.run, self.s0, self.n = run, s0, rid + 1
        self.Lr = np.zeros(max(1, self.n))
        self.party = np.zeros(max(1, self.n))
        self.party_lo = np.zeros(max(1, self.n))
        lo_in = np.zeros(S) if party_lo is None or len(party_lo) != S else np.asarray(party_lo, float)
        lo_run = np.full(max(1, self.n), np.inf)
        for i in range(S):
            self.Lr[run[i]] = max(self.Lr[run[i]], s0[i] + L[i])
            self.party[run[i]] = max(self.party[run[i]], ph[i])
            if ph[i] > 0:
                lo_run[run[i]] = min(lo_run[run[i]], lo_in[i])
        self.party_lo = np.where(np.isfinite(lo_run), lo_run, 0.0)

    def locate(self, e: np.ndarray, n: np.ndarray):
        """(segment index, run id, arclength s) of the nearest outline segment for each point."""
        S = len(self.L)
        N = len(e)
        seg = np.zeros(N, np.int64)
        sl = np.zeros(N)
        step = max(1, 3_000_000 // max(1, S))
        for a in range(0, N, step):
            ee, nn = e[a:a + step, None], n[a:a + step, None]
            wx, wy = ee - self.p0[None, :, 0], nn - self.p0[None, :, 1]
            t = np.clip(wx * self.u[None, :, 0] + wy * self.u[None, :, 1], 0.0, self.L[None, :])
            dx, dy = wx - t * self.u[None, :, 0], wy - t * self.u[None, :, 1]
            k = np.argmin(dx * dx + dy * dy, axis=1)
            seg[a:a + step] = k
            sl[a:a + step] = t[np.arange(len(k)), k]
        return seg, self.run[seg], self.s0[seg] + sl


# ------------------------------------------------------------------ styles

def _style(b, vs: float, mpf: float):
    k = b.kind
    h = key_hash(b.key, 101)
    d = dict(ww=1.1, wh=1.4, sill=0.9, pier=1.3, margin=0.8, fl=mpf, single=False, shutters=False, ribbon=False)
    if k == "industrial":
        d.update(ww=1.8, wh=1.0, sill=2.6, pier=3.0, margin=1.5, fl=max(mpf, 4.2))
    elif k == "religious":
        d.update(ww=0.95, wh=3.0, sill=2.2, pier=3.2, margin=1.6, fl=10.0, single=True)
    elif k == "civic":
        d.update(ww=1.3, wh=1.9, sill=0.8, pier=1.5, margin=1.0)
    elif k == "commercial":
        if h < 0.5:
            d.update(ww=1.7, wh=1.4, sill=0.9, pier=0.7, margin=0.6, ribbon=True)
        else:
            d.update(ww=1.2, wh=1.5, sill=0.9, pier=1.1)
    else:
        if h < 0.5:
            pass
        elif h < 0.8:
            d.update(ww=0.9, wh=1.7, sill=0.8, pier=1.4)
        else:
            d.update(ww=1.4, wh=1.35, sill=0.9, pier=1.2)
        d["shutters"] = key_hash(b.key, 102) < 0.35 and k in ("residential", "generic")
    return d


def _window_layout(Lr: np.ndarray, st) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per run: window count, first centre and centre spacing (metres, along the run), symmetric."""
    ww, pier, m = st["ww"], st["pier"], st["margin"]
    U = Lr - 2 * m
    n = np.floor((U + pier) / (ww + pier) + 0.5).astype(np.int64)
    n = np.where(U >= ww, np.maximum(n, 1), 0)
    gap = np.where(n > 1, (U - n * ww) / np.maximum(n - 1, 1), 0.0)
    n = np.where((n > 1) & (gap < 0.45), np.maximum(1, np.floor((U + 0.45) / (ww + 0.45))).astype(np.int64), n)
    step = np.where(n > 1, (U - ww) / np.maximum(n - 1, 1), 0.0)
    c0 = np.where(n > 1, m + ww / 2.0, Lr / 2.0)
    return n, c0, step


def _texture(b, mat: str, s, ly, run, x, y, z, vs: float, seed: int, fl_v: int):
    """(factor (n,), beam mask or None)."""
    kc = max(1, int(round(0.5 / vs)))
    u = hnoise(x // kc, y // kc, z // kc, seed & 0xFFFF)
    beam = None
    if mat in ("brick",):
        if vs <= 0.35:
            sc = np.floor((s + (ly % 2) * vs) / (2 * vs)).astype(np.int64)
            f = _q(hnoise(sc, ly, run, 5), 4, 0.025) * np.where(ly % 2 == 0, 1.0, 0.97) * _q(u, 2, 0.02)
        else:
            f = _q(u, 4, 0.03)
    elif mat in STONE_MATS:
        if vs <= 0.5:
            bh, bw = _vox(0.6, vs), 1.2
            row = ly // bh
            col = np.floor((s + (row % 2) * 0.6) / bw).astype(np.int64)
            f = _q(hnoise(col, row, run, 9), 4, 0.03) * _q(u, 2, 0.015)
            if vs <= 0.25:
                edge = (ly % bh == 0) | (np.floor((s + (row % 2) * 0.6) / vs) % int(round(bw / vs)) == 0)
                f = np.where(edge, f * 0.93, f)
        else:
            f = _q(u, 4, 0.03)
    elif mat in ("concrete", "cement_block"):
        f = _q(u, 4, 0.015)
        if vs <= 0.5:
            f = np.where(np.floor(s / vs) % int(round(3.0 / vs)) == 0, f * 0.94, f)
    elif mat in ("metal", "steel", "aluminium", "corrugated_iron", "iron"):
        f = _q(u, 2, 0.015) * np.where(np.floor(s / max(vs, 0.2)) % 2 == 0, 1.0, 0.95)
    elif mat in ("wood",):
        f = _q(hnoise(np.floor(s / max(vs, 0.2)).astype(np.int64), run, 3, 11), 4, 0.03) * _q(u, 2, 0.015)
    elif mat == "timber_framing":
        f = _q(u, 4, 0.02)
        if vs <= 0.5:
            bay = 1.8
            sb = s % bay
            w = max(vs, 0.2)
            loc = ly % fl_v
            beam = (sb < w) | (sb > bay - w) | (loc >= fl_v - _vox(0.25, vs)) | (ly < _vox(0.6, vs))
            bi = np.floor(s / bay).astype(np.int64)
            has_brace = hnoise(bi, run, 1, 21) < 0.45
            fr = (sb / bay) - (loc / max(1, fl_v - 1))
            beam |= has_brace & (np.abs(fr) < (w / bay) * 0.9)
    else:  # plaster / render / stucco / generic
        blot = hnoise(np.floor(s / 1.6).astype(np.int64), ly // _vox(1.6, vs), run, 13)
        f = _q(u, 4, 0.02) * _q(blot, 4, 0.012)
    return f, beam


def apply_details(b, grid, vs: float, mpf: float, wall, window, seed: int) -> None:
    """Sets b.wall_rgb for b.wx/wy/wz (and appends balcony voxels). Replaces facade.wall_colours."""
    n = len(b.wx)
    out = np.empty((n, 3), np.uint8)
    out[:] = wall
    if n == 0:
        b.wall_rgb = out
        return
    if getattr(b, "open_structure", False):
        b.wall_rgb = out
        return
    x, y, z = b.wx.astype(np.int64), b.wy.astype(np.int64), b.wz.astype(np.int64)
    ly = y - b.base_y - 1  # wall voxel row above the lowest ground (negative = foundation)
    fl_v = max(1, int(round(mpf / vs)))
    glass = b.wall_mat == "glass"
    minor = b.kind == "minor"
    runs = _Runs(b.poly, getattr(b, "party_h", None), getattr(b, "party_lo", None))
    e, nn = grid.centers_e(x), grid.centers_n(z)
    col = x * 4_000_003 + z
    ucol, first, inv = np.unique(col, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    seg_u, run_u, s_u = runs.locate(e[first], nn[first])
    seg, run, s = seg_u[inv], run_u[inv], s_u[inv]
    eave_ly = int(b.eave_y - b.base_y - 1) if b.eave_y is not None else int(ly.max()) + 1
    fine = vs <= 0.5
    tex_on = getattr(b, "facade_texture", True) and vs <= 0.35  # noise defeats the preview's quad merging
    plinth_v = _vox(0.6, vs)

    # ---- base colour + material texture + weathering gradient
    mat = b.wall_mat
    if mat is None:
        mat = {"commercial": "concrete", "industrial": "metal", "religious": "stone"}.get(b.kind, "plaster")
    f = np.ones(n)
    beam = None
    if tex_on and not glass:
        f, beam = _texture(b, mat, s, ly, run, x, y, z, vs, seed, fl_v)
    f = np.round(f * 50.0) / 50.0  # few shared shades per building: keeps the global palette small
    grime = 1.0 - (0.07 if vs <= 0.35 else 0.0) * np.clip(1.0 - (ly * vs - 0.6) / 2.0, 0.0, 1.0) * (ly >= plinth_v)
    colf = np.clip(np.asarray(wall, np.float64)[None, :] * (np.round(f * grime * 50.0) / 50.0)[:, None], 0, 255)
    out[:] = colf.astype(np.uint8)
    if beam is not None:
        out[beam] = (np.asarray(BEAM, np.float64)[None, :] * f[beam][:, None]).astype(np.uint8)

    # ---- plinth / foundation, cornice, string course
    out[ly < plinth_v] = (np.asarray(wall, np.float64)[None, :] * 0.72 * f[ly < plinth_v][:, None]).astype(np.uint8)
    cor_v = max(1, _vox(0.4, vs))
    nfl_total = max(1, eave_ly // fl_v)
    if not minor and not glass:
        cm = (ly >= eave_ly - cor_v) & (ly < eave_ly) & (ly >= fl_v)
        out[cm] = np.clip(colf[cm] * 1.1 + 4, 0, 255).astype(np.uint8)
        if fine and nfl_total >= 3 and key_hash(b.key, 103) < 0.55 and b.kind != "industrial":
            sm = ly == fl_v
            out[sm] = np.clip(colf[sm] * 1.08 + 3, 0, 255).astype(np.uint8)

    # ---- windows
    st = _style(b, vs, mpf)
    fl_w = max(1, int(round(st["fl"] / vs)))
    sill_v = max(1, int(round(st["sill"] / vs)))
    wh_v = max(1, int(round(st["wh"] / vs)))
    wh_v = max(1, min(wh_v, fl_w - 1 - sill_v)) if fl_w - 1 - sill_v >= 1 else 0
    nwin, c0, stp = _window_layout(runs.Lr, st)
    win_ok = (not minor) and (not glass) and fl_w >= 3 and wh_v >= 1
    floor_i = ly // fl_w
    loc = ly % fl_w
    nfl = max(1, (eave_ly - cor_v) // fl_w)
    k_idx = np.zeros(n, np.int64)
    cen = np.zeros(n)
    inwin = np.zeros(n, bool)
    if win_ok:
        nr, c0r, sr = nwin[run], c0[run], stp[run]
        k_idx = np.where(nr > 1, np.clip(np.round((s - c0r) / np.maximum(sr, 1e-9)), 0, np.maximum(nr - 1, 0)), 0).astype(np.int64)
        cen = c0r + k_idx * sr
        dist = np.abs(s - cen)
        inwin = (nr > 0) & (dist <= st["ww"] / 2.0 - 1e-6)
        row_ok = (loc >= sill_v) & (loc < sill_v + wh_v) & (ly >= 0)
        top_ok = floor_i * fl_w + sill_v + wh_v + cor_v <= eave_ly
        if st["single"]:
            row_ok &= floor_i == 0
        party = (runs.party[run] > (ly + 1) * vs - 0.4) & (runs.party_lo[run] <= ly * vs + 0.4)
        win = inwin & row_ok & top_ok & ~party
        # per-window tint (exact base colour for a third of the windows) and curtains
        uw = hnoise(run * 64 + k_idx, floor_i, 3, 31)
        tint = np.where(uw < 0.33, 0.9, np.where(uw < 0.66, 1.0, 1.1)) if vs <= 0.35 else np.ones(n)
        wc = np.clip(np.asarray(window, np.float64)[None, :] * tint[:, None], 0, 255).astype(np.uint8)
        if vs <= 0.35:
            cur = (hnoise(run * 64 + k_idx, floor_i, 5, 33) < 0.1)
            wc[cur] = CURTAIN
        out[win] = wc[win]
        if vs <= 0.35:  # frames, mullion, sills, lintels, shutters
            wwv = st["ww"] / vs
            edge_s = np.abs(s - cen) > st["ww"] / 2.0 - vs * 1.0
            edge_r = (loc == sill_v) | (loc == sill_v + wh_v - 1)
            fr = win & (edge_s | edge_r)
            out[fr] = FRAME
            if wwv >= 5:
                mull = win & (np.abs(s - cen) < vs * 0.5 + 1e-6) & ~fr
                out[mull] = FRAME
            near = (np.abs(s - cen) <= st["ww"] / 2.0 + vs * 2) & (nwin[run] > 0)
            sm = near & (loc == sill_v - 1) & top_ok & (ly >= plinth_v) & ~party
            if not st["single"]:
                out[sm] = np.clip(colf[sm] * 1.15 + 6, 0, 255).astype(np.uint8)
            lm = (np.abs(s - cen) <= st["ww"] / 2.0 + vs) & (nwin[run] > 0) & (loc == sill_v + wh_v) \
                & (floor_i * fl_w + sill_v + wh_v + cor_v <= eave_ly) & ~party & (ly >= 0) & (ly >= plinth_v)
            if not st["single"]:
                out[lm] = np.clip(colf[lm] * 0.82, 0, 255).astype(np.uint8)
            if st["shutters"]:
                sc_ = SHUTTER_COLOURS[int(key_hash(b.key, 104) * len(SHUTTER_COLOURS)) % len(SHUTTER_COLOURS)]
                sd = np.abs(s - cen)
                shm = (sd > st["ww"] / 2.0 - 1e-6) & (sd <= st["ww"] / 2.0 + 0.42) & row_ok & top_ok & ~party & (nwin[run] > 0)
                out[shm] = (np.asarray(sc_, np.float64)[None, :] * f[shm][:, None]).astype(np.uint8)

    # ---- gable attic window (voxels of the gable triangle above the eave)
    shp = b.roof.shape if hasattr(b.roof, "shape") else "flat"
    if fine and shp in ("gabled", "hipped") and b.rmax_v >= 5 and not minor and not glass:
        wa = _vox(0.9, vs)
        above = (ly >= eave_ly + 1) & (ly < eave_ly + 1 + wa)
        mid = np.abs(s - runs.Lr[run] / 2.0) <= max(0.45, vs)
        if above.any():
            # only on gable ends (wall columns that exist above the eave)
            out[above & mid & (runs.party[run] <= 0) & (ly + 2 < b.rmax_v + eave_ly)] = _shade(window, 0.95)

    # ---- glass curtain wall: panes with mullions and floor slabs
    if glass:
        pw = 1.5
        pane = np.floor(s / pw).astype(np.int64)
        up = hnoise(pane + run * 100, floor_i, 7, 41)
        base = np.clip(np.asarray(window, np.float64)[None, :] * (0.85 + 0.4 * up)[:, None], 0, 255)
        out[:] = base.astype(np.uint8)
        if vs <= 0.5:
            mull = (s % pw) < max(vs, 0.12)
            slab = (loc == fl_w - 1) | (ly < plinth_v)
            out[mull | slab] = (150, 156, 162)
        else:
            out[ly < plinth_v] = _shade(wall, 0.72)

    # ---- ground-floor shopfront with signboard
    if b.kind == "commercial" and (b.btype or "") in SHOP_TYPES and not glass and vs <= 0.75:
        bay = 3.5
        sf_s = s - 0.7
        inside = (s > 0.7) & (s < runs.Lr[run] - 0.7) & (runs.party[run] <= 0.5)
        sb = np.where(sf_s >= 0, sf_s % bay, 0.0)
        glass_band = (ly >= _vox(0.4, vs)) & (ly < _vox(2.6, vs)) & inside & (sb > 0.2) & (sb < bay - 0.3)
        out[glass_band] = _shade(window, 0.9)
        if vs <= 0.5:
            sign = (ly >= _vox(2.7, vs)) & (ly < _vox(3.3, vs)) & inside
            sc_ = SIGN_COLOURS[int(key_hash(b.key, 105) * len(SIGN_COLOURS)) % len(SIGN_COLOURS)]
            out[sign] = sc_

    # ---- doors: entrance nodes first, else one procedural door
    rng = np.random.default_rng(seed ^ 0x5F3759DF)
    door_rgb = DOOR_COLOURS[int(rng.integers(len(DOOR_COLOURS)))]
    dh, dw = _vox(2.1, vs), 1.0
    ground = np.flatnonzero((ly == 0) & (runs.party[run] <= 0.5))
    if len(ground) == 0:
        ground = np.flatnonzero(ly == 0)
    ent = getattr(b, "entrances", None) or []
    anchors = []  # (run, s)
    if ent and len(ground):
        for (pe, pn) in ent:
            d2 = (e[ground] - pe) ** 2 + (nn[ground] - pn) ** 2
            k = int(ground[int(np.argmin(d2))])
            if float(d2.min()) <= (1.6 + vs) ** 2:
                anchors.append((int(run[k]), float(s[k])))
    front_run = None
    if not anchors and len(ground):
        cand_runs = np.unique(run[ground])
        free = [r for r in cand_runs if runs.Lr[r] >= 2.0] or list(cand_runs)
        best = max(free, key=lambda r: (round(float(runs.Lr[r]), 2), -int(r)))  # longest open facade
        g_in = ground[run[ground] == best]
        smin, smax = float(s[g_in].min()), float(s[g_in].max())
        a0 = smin + (smax - smin) * (0.3 + 0.4 * float(rng.random()))
        anchors.append((int(best), a0))
    for r0, s0 in anchors:
        m = (ly >= 0) & (ly < dh) & (run == r0) & (np.abs(s - s0) < dw / 2.0)
        out[m] = door_rgb
        front_run = r0 if front_run is None else front_run
        if fine:  # lintel/frame above the door
            lm = (ly == dh) & (run == r0) & (np.abs(s - s0) < dw / 2.0 + vs)
            out[lm] = np.clip(colf[lm] * 0.8, 0, 255).astype(np.uint8)

    b.wall_rgb = out

    # ---- balconies below the windows of the front facade of residential buildings
    floors = int(max(0, ly.max())) // fl_w + 1 if len(ly) else 0
    if (b.kind == "residential" and vs <= 0.75 and floors >= 3 and front_run is not None and not glass
            and win_ok and rng.random() < 0.7):
        depth = max(1, _vox(0.8, vs))
        bal_k = hnoise(run * 64 + k_idx, 17, 5, 61) < 0.75
        base = ((run == front_run) & (np.abs(s - cen) <= st["ww"] / 2.0 + 0.3) & (nwin[run] > 0) & bal_k
                & (floor_i >= 1) & (floor_i < nfl) & (loc == 0))
        rail_m = ((run == front_run) & (np.abs(s - cen) <= st["ww"] / 2.0 + 0.3) & (nwin[run] > 0) & bal_k
                  & (floor_i >= 1) & (floor_i < nfl) & (loc == 1) & (vs <= 0.5))
        nx_, nz_ = runs.nrm[seg, 0], runs.nrm[seg, 1]
        dx = np.where(np.abs(nx_) >= np.abs(nz_), np.sign(nx_), 0).astype(np.int64)
        dz = np.where(np.abs(nz_) > np.abs(nx_), -np.sign(nz_), 0).astype(np.int64)  # z grows southwards
        parts = []
        for j in range(1, depth + 1):
            mj = base & ((dx != 0) | (dz != 0))
            if mj.any():
                parts.append((x[mj] + dx[mj] * j, y[mj], z[mj] + dz[mj] * j, SLAB))
        if rail_m.any():
            mj = rail_m & ((dx != 0) | (dz != 0))
            parts.append((x[mj] + dx[mj] * depth, y[mj], z[mj] + dz[mj] * depth, RAIL))
        if parts:
            ax = np.concatenate([p[0] for p in parts]).astype(np.int32)
            ay = np.concatenate([p[1] for p in parts]).astype(np.int32)
            az = np.concatenate([p[2] for p in parts]).astype(np.int32)
            ac = np.concatenate([np.tile(np.array(p[3], np.uint8), (len(p[0]), 1)) for p in parts])
            b.wx = np.concatenate([b.wx, ax])
            b.wy = np.concatenate([b.wy, ay])
            b.wz = np.concatenate([b.wz, az])
            b.wall_rgb = np.concatenate([out, ac])
