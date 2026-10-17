"""Facade analysis on a rectified, metric front elevation (classical CV, numpy only, deterministic).

Pipeline: block-average to ~16 px/m -> k-means for the dominant (wall) colour -> colour-distance mask of
everything that is not wall -> row/column occupancy profiles -> bands (floors x bays) -> cells -> tight
window/door rectangles -> regularisation -> colours (wall / trim / glass) and material class. Every field gets
a 0..1 confidence; nothing here raises on weak evidence (only on a blank image)."""
from __future__ import annotations

import colorsys
from typing import Callable, List, Optional, Sequence, Tuple

import numpy as np

from ..protocol import PipelineError

TARGET_PPM = 16.0
DEFAULT_GLASS = (62, 84, 108)


def _noop() -> None:
    return None


# --------------------------------------------------------------------------- helpers

def block_mean(img: np.ndarray, f: int) -> np.ndarray:
    h, w = (img.shape[0] // f) * f, (img.shape[1] // f) * f
    a = img[:h, :w].astype(np.float32)
    return a.reshape(h // f, f, w // f, f, 3).mean(axis=(1, 3))


def kmeans(px: np.ndarray, k: int, iters: int = 12, check: Callable[[], None] = _noop):
    """Deterministic k-means++ (fixed seed) on (N,3) float pixels. Returns (centroids (k,3), counts (k,))."""
    n = len(px)
    if n > 20000:
        px = px[:: int(np.ceil(n / 20000))]
        n = len(px)
    k = max(1, min(k, n))
    rng = np.random.default_rng(12345)
    cent = [px[int(rng.integers(n))]]
    d2 = ((px - cent[0]) ** 2).sum(1)
    for _ in range(1, k):
        s = float(d2.sum())
        if s <= 1e-9:
            cent.append(px[int(rng.integers(n))])
        else:
            cent.append(px[min(n - 1, int(np.searchsorted(np.cumsum(d2), rng.random() * s)))])
        d2 = np.minimum(d2, ((px - cent[-1]) ** 2).sum(1))
    C = np.asarray(cent, np.float64)
    for _ in range(iters):
        check()
        lab = np.argmin(((px[:, None, :] - C[None, :, :]) ** 2).sum(2), axis=1)
        newC = C.copy()
        for j in range(k):
            m = lab == j
            if m.any():
                newC[j] = px[m].mean(0)
        if np.allclose(newC, C, atol=0.05):
            C = newC
            break
        C = newC
    lab = np.argmin(((px[:, None, :] - C[None, :, :]) ** 2).sum(2), axis=1)
    return C, np.bincount(lab, minlength=k)


def _otsu(v: np.ndarray, lo: float, hi: float) -> float:
    hist, edges = np.histogram(v, bins=64, range=(0.0, max(1.0, float(v.max()))))
    p = hist / max(1, hist.sum())
    om = np.cumsum(p)
    mu = np.cumsum(p * (edges[:-1] + edges[1:]) / 2)
    mt = mu[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        sb = (mt * om - mu) ** 2 / (om * (1 - om))
    sb = np.nan_to_num(sb)
    t = float(edges[int(np.argmax(sb)) + 1])
    return float(np.clip(t, lo, hi))


def _box(a: np.ndarray, r: int) -> np.ndarray:
    """1-D moving average (edge-padded)."""
    if r <= 0 or len(a) == 0:
        return a
    k = 2 * r + 1
    p = np.pad(a.astype(np.float64), r, mode="edge")
    c = np.cumsum(np.insert(p, 0, 0.0))
    return (c[k:] - c[:-k]) / k


def _majority(m: np.ndarray) -> np.ndarray:
    """3x3 majority filter on a bool mask."""
    p = np.pad(m.astype(np.uint8), 1)
    s = sum(p[i:i + m.shape[0], j:j + m.shape[1]] for i in range(3) for j in range(3))
    return s >= 5


def _bands(profile: np.ndarray, pa: float, min_len_m: float, gap_m: float) -> Tuple[List[Tuple[int, int]], float]:
    """Runs of high occupancy [a, b) in px and the profile contrast (p90 - p10)."""
    p = _box(profile, 1)
    lo, hi = float(np.percentile(p, 10)), float(np.percentile(p, 90))
    contrast = hi - lo
    if contrast < 0.10:
        return [], contrast
    thr = 0.5 * (lo + hi)
    on = p > thr
    runs: List[List[int]] = []
    i, n = 0, len(on)
    while i < n:
        if on[i]:
            j = i
            while j < n and on[j]:
                j += 1
            runs.append([i, j])
            i = j
        else:
            i += 1
    gap = max(1, int(round(gap_m * pa)))
    merged: List[List[int]] = []
    for r in runs:
        if merged and r[0] - merged[-1][1] <= gap:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    ml = max(2, int(round(min_len_m * pa)))
    return [(a, b) for a, b in merged if b - a >= ml], contrast


def _hsv(rgb: Sequence[float]) -> Tuple[float, float, float]:
    h, s, v = colorsys.rgb_to_hsv(*(float(c) / 255.0 for c in rgb))
    return h * 360.0, s, v


def _rgb(a) -> Tuple[int, int, int]:
    return tuple(int(np.clip(round(float(c)), 0, 255)) for c in a)  # type: ignore


# --------------------------------------------------------------------------- main entry

def analyze_rectified(rect: np.ndarray, ppm: float, wall_w: float, wall_h: float,
                      floors_hint: Optional[int] = None, check: Callable[[], None] = _noop) -> dict:
    """FacadeSpec dict (contract) for a rectified elevation of wall_w x wall_h metres."""
    f = max(1, int(round(ppm / TARGET_PPM)))
    A = block_mean(rect, f)
    hA, wA, _ = A.shape
    if hA < 8 or wA < 8:
        raise PipelineError("FACADE_ANALYSIS_FAILED", "Rectified wall is too small to analyse")
    lum = A @ np.array([0.299, 0.587, 0.114], np.float32)
    if float(lum.std()) < 2.0:
        raise PipelineError("FACADE_ANALYSIS_FAILED", "The marked wall region is blank (no visible structure)")
    check()
    mx, my = wall_w / wA, wall_h / hA          # metres per analysis pixel
    pax, pay = 1.0 / mx, 1.0 / my

    px = A.reshape(-1, 3).astype(np.float64)
    C, cnt = kmeans(px, 4, check=check)
    wall0 = C[int(np.argmax(cnt))]
    D = np.sqrt(((A - wall0.astype(np.float32)) ** 2).sum(2))
    near = D[D < np.percentile(D, 60)]
    sigma = float(near.std()) if near.size else 8.0
    thr = max(_otsu(D.reshape(-1), 22.0, 80.0), 2.5 * sigma + 6.0)
    thr = float(min(thr, 95.0))
    M = _majority(D > thr)
    check()

    # ---- bands: columns (bays) then rows (floors), refined using the other axis' bands
    colb, c_con = _bands(M.mean(0), pax, 0.35, 0.12)
    rowb, r_con = _bands(M.mean(1), pay, 0.45, 0.15)
    if colb:
        cm = np.zeros(wA, bool)
        for a, b in colb:
            cm[a:b] = True
        rowb2, r_con2 = _bands(M[:, cm].mean(1), pay, 0.45, 0.15)
        if rowb2:
            rowb, r_con = rowb2, r_con2
    if rowb:
        rm = np.zeros(hA, bool)
        for a, b in rowb:
            rm[a:b] = True
        colb2, c_con2 = _bands(M[rm].mean(0), pax, 0.35, 0.12)
        if colb2:
            colb, c_con = colb2, c_con2
    check()

    # ---- columns per floor band: a bay that has an opening on one floor only (door below, blank wall above) is
    # invisible in the whole-wall profile, so every floor band gets its own bays
    row_cols: List[List[Tuple[int, int]]] = []
    for (y0, y1) in rowb:
        cb, _ = _bands(M[y0:y1].mean(0), pax, 0.35, 0.12)
        row_cols.append(cb or colb)
    if row_cols:
        allc = sorted(c for cb in row_cols for c in cb)
        colb = []
        for a_, b_ in allc:
            if colb and a_ <= colb[-1][1]:
                colb[-1] = (colb[-1][0], max(colb[-1][1], b_))
            else:
                colb.append((a_, b_))

    # ---- cells -> tight rectangles (px: x0,x1,y0,y1 with y top-down)
    rects: List[List[int]] = []
    for (y0, y1), cols_r in zip(rowb, row_cols):
        for (x0, x1) in cols_r:
            sub = M[y0:y1, x0:x1]
            if sub.size == 0 or sub.mean() < 0.30:
                continue
            rr = np.flatnonzero(sub.mean(1) >= 0.30)
            cc = np.flatnonzero(sub.mean(0) >= 0.30)
            if len(rr) == 0 or len(cc) == 0:
                continue
            r = [x0 + int(cc[0]), x0 + int(cc[-1]) + 1, y0 + int(rr[0]), y0 + int(rr[-1]) + 1]
            while r[2] > 0 and M[r[2] - 1, r[0]:r[1]].mean() >= 0.5:  # follow the opening beyond the band
                r[2] -= 1
            while r[3] < hA and M[r[3], r[0]:r[1]].mean() >= 0.5:
                r[3] += 1
            if (r[1] - r[0]) * mx >= 0.35 and (r[3] - r[2]) * my >= 0.45:
                rects.append(r)

    # ---- regularise: align edges of rects sharing a column band / row band (median), skip doors
    def snap(rs: List[List[int]], lo_i: int, hi_i: int, bands) -> None:
        for (a, b) in bands:
            grp = [r for r in rs if a <= (r[lo_i] + r[hi_i]) // 2 < b]
            if len(grp) >= 2:
                lo, hi = int(np.median([r[lo_i] for r in grp])), int(np.median([r[hi_i] for r in grp]))
                for r in grp:
                    if abs(r[lo_i] - lo) <= 0.25 / (mx if lo_i == 0 else my) and abs(r[hi_i] - hi) <= 0.25 / (mx if lo_i == 0 else my):
                        r[lo_i], r[hi_i] = lo, hi
    snap(rects, 0, 1, colb)

    windows, doors = [], []
    cand = []
    for r in rects:
        u, w = r[0] * mx, (r[1] - r[0]) * mx
        v, h = wall_h - r[3] * my, (r[3] - r[2]) * my
        cand.append((r, u, w, v, h))
    for (r, u, w, v, h) in cand:
        # door: touches the ground (the user's quad may stop a little above the street), door sized, and either
        # tall and narrow, or reaching v = 0, or clearly taller than the other openings of its floor
        others = [c[4] for c in cand if c[0] is not r and abs((c[0][2] + c[0][3]) - (r[2] + r[3])) < 0.8 * (r[3] - r[2])]
        med_h = float(np.median(others)) if others else 0.0
        touch = v <= 0.15           # bottoms out at the street (the bottom of the marked quad)
        if touch:
            is_door = (h <= 4.2 and 0.6 <= w <= 2.8 and
                       (h >= max(1.25, med_h * 1.08) or (h / max(w, 1e-6) >= 1.3 or med_h == 0.0) and h >= 1.6))
        else:
            is_door = (v <= 0.60 and 1.7 <= h <= 3.6 and 0.7 <= w <= 2.6 and
                       (h / max(w, 1e-6) >= 1.3 or med_h == 0.0 or h >= med_h + 0.35))
        if is_door:
            doors.append(dict(u=u, v=0.0, w=w, h=h + max(0.0, v)))
        else:
            windows.append(dict(u=u, v=max(0.0, v), w=w, h=h))
    # same-row alignment for windows (median v / h inside a row band)
    for (a, b) in rowb:
        grp = [wi for wi in windows if a <= (wall_h - wi["v"] - wi["h"] / 2.0) / my < b]
        if len(grp) >= 2:
            v_ = float(np.median([g["v"] for g in grp]))
            h_ = float(np.median([g["h"] for g in grp]))
            for g in grp:
                if abs(g["v"] - v_) < 0.25 and abs(g["h"] - h_) < 0.25:
                    g["v"], g["h"] = v_, h_
    windows.sort(key=lambda r: (round(r["v"], 2), r["u"]))
    doors.sort(key=lambda r: r["u"])
    check()

    # ---- floors
    bands_v = sorted(((wall_h - b * my), (wall_h - a * my)) for a, b in rowb if any(
        a <= (wall_h - wi["v"] - wi["h"] / 2.0) / my < b for wi in windows) or
        any(d["v"] + d["h"] / 2.0 > 0 and a <= (wall_h - d["h"] / 2.0) / my < b for d in doors))
    floors_conf = 0.2
    if bands_v:
        floors = len(bands_v)
        centers = np.array([(a + b) / 2.0 for a, b in bands_v])
        lines = [float((bands_v[i][1] + bands_v[i + 1][0]) / 2.0) for i in range(len(bands_v) - 1)]
        if len(centers) >= 3:
            d = np.diff(centers)
            floors_conf = float(np.clip(1.0 - d.std() / max(d.mean(), 1e-6) * 2.0, 0.25, 0.95))
        else:
            floors_conf = 0.55 if len(centers) == 2 else 0.4
        if floors_hint and floors_hint != floors:
            floors_conf *= 0.7
    else:
        floors, lines, floors_conf = _floors_from_edges(lum, pay, my, wall_h, floors_hint)
    lines = [l for l in lines if 0.3 < l < wall_h - 0.3]
    lines = sorted(set(round(l, 3) for l in lines))

    # ---- colours
    excl = np.zeros((hA, wA), bool)
    pad_x, pad_y = int(round(0.15 * pax)), int(round(0.15 * pay))

    def box(r, grow):
        x0, x1, y0, y1 = r
        return (max(0, y0 - grow[1]), min(hA, y1 + grow[1]), max(0, x0 - grow[0]), min(wA, x1 + grow[0]))
    def clampr(r):
        return [int(np.clip(r[0], 0, wA)), int(np.clip(r[1], 0, wA)), int(np.clip(r[2], 0, hA)),
                int(np.clip(r[3], 0, hA))]
    all_px = []
    for wi in windows:
        all_px.append(clampr([round(wi["u"] / mx), round((wi["u"] + wi["w"]) / mx),
                              round((wall_h - wi["v"] - wi["h"]) / my), round((wall_h - wi["v"]) / my)]))
    for d in doors:
        all_px.append(clampr([round(d["u"] / mx), round((d["u"] + d["w"]) / mx),
                              round((wall_h - d["v"] - d["h"]) / my), round((wall_h - d["v"]) / my)]))
    for r in all_px:
        a, b, c, d_ = box(r, (pad_x, pad_y))
        excl[a:b, c:d_] = True
    wall_mask = ~excl & (D < thr * 1.3)
    if int(wall_mask.sum()) >= 30:
        wall_rgb = np.median(A[wall_mask], axis=0)
        purity = float(wall_mask.sum()) / max(1, int((~excl).sum()))
        spread = float(A[wall_mask].std(0).mean())
    else:
        wall_rgb, purity, spread = wall0, 0.3, 30.0
    colour_conf = float(np.clip(0.35 + 0.5 * purity + 0.25 * (1.0 - min(spread, 50.0) / 50.0), 0.1, 0.95))

    glass_rgb = DEFAULT_GLASS
    glass_known = False
    gp = []
    for (x0, x1, y0, y1) in all_px[:len(windows)]:
        mxp, myp = max(1, (x1 - x0) // 5), max(1, (y1 - y0) // 5)
        if y1 - y0 > 2 * myp and x1 - x0 > 2 * mxp:
            gp.append(A[y0 + myp:y1 - myp, x0 + mxp:x1 - mxp].reshape(-1, 3))
    if gp:
        gp = np.concatenate(gp)
        glass_rgb, glass_known = np.median(gp, axis=0), True

    ring = np.zeros((hA, wA), bool)
    for r in all_px:
        g1 = (int(round(0.14 * pax)), int(round(0.14 * pay)))
        a, b, c, d_ = box(r, g1)
        ring[a:b, c:d_] = True
    for r in all_px:
        ring[max(0, r[2]):min(hA, r[3]), max(0, r[0]):min(wA, r[1])] = False
    tmask = ring & (np.sqrt(((A - wall_rgb.astype(np.float32)) ** 2).sum(2)) > 0.35 * thr)
    wl = float(np.dot(wall_rgb, [0.299, 0.587, 0.114]))
    if int(tmask.sum()) >= 40:
        trim_rgb = np.median(A[tmask], axis=0)
    else:
        trim_rgb = np.clip(wall_rgb * (0.82 if wl > 150 else 1.25) + (0 if wl > 150 else 10), 0, 255)

    # ---- material class
    win_frac = sum(w["w"] * w["h"] for w in windows) / max(1e-6, wall_w * wall_h)
    mat = _material(wall_rgb, A, wall_mask, win_frac, glass_known)

    # ---- confidences
    if windows:
        reg = 1.0
        if len(windows) >= 3:
            ws = np.array([w["w"] for w in windows]); hs = np.array([w["h"] for w in windows])
            reg = float(np.clip(1.0 - (ws.std() / ws.mean() + hs.std() / hs.mean()), 0.3, 1.0))
        cont = min(1.0, (c_con + r_con) / 0.6)
        win_conf = float(np.clip(cont * reg * (0.6 if len(windows) < 3 else 1.0), 0.05, 0.95))
    else:
        win_conf = 0.05
    door_conf = float(np.clip(0.35 + 0.6 * min(1.0, c_con / 0.4), 0.2, 0.9)) if doors else 0.15
    if not windows:
        floors_conf = min(floors_conf, 0.3)

    rd = lambda x: round(float(x), 3)
    return {
        "version": 1, "wallWidthM": rd(wall_w), "wallHeightM": rd(wall_h), "floors": int(max(1, floors)),
        "floorLinesV": [rd(l) for l in lines],
        "wallColour": list(_rgb(wall_rgb)), "trimColour": list(_rgb(trim_rgb)),
        "glassColour": list(_rgb(glass_rgb)), "material": mat,
        "windows": [dict(u=rd(w["u"]), v=rd(w["v"]), w=rd(w["w"]), h=rd(w["h"])) for w in windows],
        "doors": [dict(u=rd(d["u"]), v=0, w=rd(d["w"]), h=rd(d["h"])) for d in doors],
        "confidence": {"floors": rd(np.clip(floors_conf, 0, 1)), "windows": rd(win_conf),
                       "doors": rd(door_conf), "colour": rd(colour_conf)},
    }


def _floors_from_edges(lum: np.ndarray, pay: float, my: float, wall_h: float, hint: Optional[int]):
    """No window evidence: floor pitch from the autocorrelation of horizontal-edge energy per row."""
    gy = np.abs(np.diff(lum, axis=0)).mean(1)
    gy = gy - _box(gy, int(round(0.4 * pay)) + 1)
    n = len(gy)
    lo, hi = int(round(2.2 * pay)), min(n // 2, int(round(6.0 * pay)))
    best, conf = None, 0.0
    if hi > lo + 2 and float(gy.std()) > 1e-3:
        ac = np.array([np.dot(gy[:n - k], gy[k:]) / (n - k) for k in range(0, hi + 1)]) / (np.dot(gy, gy) / n)
        k = lo + int(np.argmax(ac[lo:hi + 1]))
        if ac[k] > 0.25:
            best, conf = k, float(min(0.6, ac[k]))
    if best is not None:
        pitch = best * my
        fl = max(1, int(round(wall_h / pitch)))
        if hint:
            fl = hint if abs(fl - hint) <= 1 else fl
        pitch = wall_h / fl
        return fl, [pitch * i for i in range(1, fl)], conf * 0.7
    fl = hint or max(1, int(round(wall_h / 3.2)))
    return fl, [wall_h / fl * i for i in range(1, fl)], 0.15


def _material(wall_rgb, A, wall_mask, win_frac: float, glass_known: bool) -> str:
    if win_frac > 0.5:
        return "glass"
    h, s, v = _hsv(wall_rgb)
    if int(wall_mask.sum()) > 50:
        L = A @ np.array([0.299, 0.587, 0.114], np.float32)
        tex = float(L[wall_mask].std())
    else:
        tex = 0.0
    if (h <= 28 or h >= 345) and 0.30 <= s <= 0.80 and 0.25 <= v <= 0.85:
        return "brick"
    if 20 <= h <= 48 and 0.25 <= s <= 0.70 and v < 0.55:
        return "wood"
    if s < 0.12 and v >= 0.5:
        return "metal" if tex > 14 and v > 0.7 else ("concrete" if v < 0.72 else "plaster")
    if s < 0.12:
        return "concrete"
    if s < 0.28 and tex > 10:
        return "stone"
    return "plaster"
