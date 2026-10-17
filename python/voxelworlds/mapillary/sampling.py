"""Pure-numpy photo sampling for wall voxels: facade pixel mask, pinhole projection onto the wall plane,
multi-image median colour with Lab outlier rejection. No network, no heavy dependencies.

Thumbnails are stored as uint8 (h, w, 4): RGB plus an alpha channel that is 255 for "usable facade pixel" and
0 for pixels excluded by `facade_alpha` (sky, vegetation, car-hood band)."""
from __future__ import annotations

import math
from typing import Tuple

import numpy as np

from ..config import Config

# ── sRGB <-> linear / Lab ───────────────────────────────────────────────────────────────────────────────
_LUT = np.where(np.arange(256) / 255.0 <= 0.04045, np.arange(256) / 255.0 / 12.92,
                (((np.arange(256) / 255.0) + 0.055) / 1.055) ** 2.4).astype(np.float32)
_M = np.array([[0.4124564, 0.3575761, 0.1804375],
               [0.2126729, 0.7151522, 0.0721750],
               [0.0193339, 0.1191920, 0.9503041]], np.float32)
_WHITE = np.array([0.95047, 1.0, 1.08883], np.float32)


def srgb_to_linear(u8: np.ndarray) -> np.ndarray:
    return _LUT[u8]


def linear_to_srgb8(lin: np.ndarray) -> np.ndarray:
    x = np.clip(lin, 0.0, 1.0)
    s = np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)
    return np.clip(np.rint(s * 255.0), 0, 255).astype(np.uint8)


def linear_to_lab(lin: np.ndarray) -> np.ndarray:
    xyz = (lin @ _M.T) / _WHITE
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16.0 / 116.0)
    return np.stack([116.0 * f[..., 1] - 16.0, 500.0 * (f[..., 0] - f[..., 1]),
                     200.0 * (f[..., 1] - f[..., 2])], -1)


# ── non-facade pixel exclusion ──────────────────────────────────────────────────────────────────────────
def facade_alpha(rgb: np.ndarray, hood_frac: float = 0.12) -> np.ndarray:
    """uint8 alpha (255 usable / 0 excluded) for an (h, w, 3) uint8 image. Conservative heuristics:
    * sky: bright blue-ish, white or (upper half) overcast-grey pixels that connect to the top edge;
    * vegetation: green-dominant saturated pixels;
    * bottom `hood_frac` of the frame (vehicle hood / road)."""
    h, w, _ = rgb.shape
    a = rgb.astype(np.float32) / 255.0
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(-1), a.min(-1)
    sat = (mx - mn) / (mx + 1e-6)
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    rowfrac = (np.arange(h, dtype=np.float32) / max(1, h - 1))[:, None]
    blue = (b >= r + 0.02) & (b >= g - 0.02) & (lum >= 0.45) & (sat < 0.65)
    white = (lum >= 0.88) & (sat < 0.07)
    grey = (sat < 0.06) & (lum >= 0.55) & (rowfrac < 0.5)
    skyish = blue | white | grey
    sky = np.logical_and.accumulate(skyish, axis=0)  # contiguous from the top edge
    for k in (1, 2):  # halo below the sky boundary
        sky[k:] |= sky[:-k]
    veg = (g > r * 1.08) & (g > b * 1.08) & (sat > 0.16) & (lum > 0.08)
    bad = sky | veg
    bad[int(h * (1.0 - hood_frac)):] = True
    return np.where(bad, 0, 255).astype(np.uint8)


def prepare_thumb(rgb: np.ndarray) -> np.ndarray:
    """(h, w, 3) uint8 -> (h, w, 4) uint8 with the facade alpha attached."""
    return np.concatenate([rgb, facade_alpha(rgb)[..., None]], -1)


# ── projection / sampling ───────────────────────────────────────────────────────────────────────────────
def project(h: int, w: int, cam_e: float, cam_n: float, heading: float, pe: np.ndarray, pn: np.ndarray,
            ph: np.ndarray, cfg: Config) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pinhole projection of world points (E, N, height above the camera's ground) to pixel (px, py) and a
    validity mask. Camera: level, heading = compass angle (rad, clockwise from north), horizontal FOV from cfg,
    height cfg.mapillary_camera_height_m. This is the wall-plane homography evaluated at the given points."""
    th = math.tan(math.radians(cfg.mapillary_hfov_deg) / 2.0)
    tv = th * h / w
    fe, fn = math.sin(heading), math.cos(heading)
    re, rn = math.cos(heading), -math.sin(heading)
    de, dn = pe - cam_e, pn - cam_n
    zc = de * fe + dn * fn
    xc = de * re + dn * rn
    yc = ph - cfg.mapillary_camera_height_m
    okz = zc > 0.5
    zs = np.where(okz, zc, 1.0)
    u = 0.5 + (xc / zs) / (2.0 * th)
    v = 0.5 - (yc / zs) / (2.0 * tv)
    ok = okz & (u > 0.01) & (u < 0.99) & (v > 0.01) & (v < 0.99)
    px = np.clip((u * w).astype(np.int64), 0, w - 1)
    py = np.clip((v * h).astype(np.int64), 0, h - 1)
    return px, py, ok


# 3x3 sample pattern across a voxel face (fractions of the voxel size along the wall / vertically)
PATTERN = np.array([(a, b) for b in (-1 / 3, 0.0, 1 / 3) for a in (-1 / 3, 0.0, 1 / 3)], np.float32)


def sample_voxels(img: np.ndarray, cam_e: float, cam_n: float, heading: float,
                  pe: np.ndarray, pn: np.ndarray, te: np.ndarray, tn: np.ndarray, hm: np.ndarray,
                  vs: float, cfg: Config) -> Tuple[np.ndarray, np.ndarray]:
    """Sample one thumbnail for n wall voxels. (pe, pn): voxel centre projected onto the wall plane,
    (te, tn): unit wall tangent, hm: voxel centre height above ground (m). Returns
    (rgb uint8 (n, P, 3), valid bool (n, P)) with P = len(PATTERN); samples on excluded pixels (alpha 0) or
    below `mapillary_min_height_m` are invalid."""
    h, w = img.shape[:2]
    n = len(pe)
    P = len(PATTERN)
    ee = pe[:, None] + PATTERN[None, :, 0] * vs * te[:, None]
    nn = pn[:, None] + PATTERN[None, :, 0] * vs * tn[:, None]
    hh = hm[:, None] + PATTERN[None, :, 1] * vs
    px, py, ok = project(h, w, cam_e, cam_n, heading, ee.reshape(-1), nn.reshape(-1), hh.reshape(-1), cfg)
    px, py, ok = px.reshape(n, P), py.reshape(n, P), ok.reshape(n, P)
    px = np.where(ok, px, 0)
    py = np.where(ok, py, 0)
    px_ = img[py, px]
    ok &= (px_[..., 3] > 0) & (hh >= cfg.mapillary_min_height_m)
    return px_[..., :3], ok


def median_colour(samples: np.ndarray, valid: np.ndarray, min_samples: int, de_max: float = 28.0,
                  chunk: int = 8192) -> Tuple[np.ndarray, np.ndarray]:
    """Per-voxel median colour over S samples (n, S, 3) uint8 with mask (n, S) in linear RGB, after one round
    of Lab outlier rejection (samples farther than `de_max` from the first median are dropped when >= 3 remain).
    Returns (rgb uint8 (n, 3), ok bool (n,)); ok False when fewer than `min_samples` valid samples."""
    n, S, _ = samples.shape
    out = np.zeros((n, 3), np.uint8)
    good = np.zeros(n, bool)
    for s in range(0, n, chunk):
        e = min(n, s + chunk)
        lin = srgb_to_linear(samples[s:e]).astype(np.float32)
        v = valid[s:e]
        cnt = v.sum(1)
        lin = np.where(v[..., None], lin, np.nan)
        med = _nanmedian(lin, cnt)
        # outlier rejection
        lab = linear_to_lab(np.nan_to_num(lin))
        labm = linear_to_lab(med)
        d = np.sqrt(((lab - labm[:, None, :]) ** 2).sum(-1))
        keep = v & (d <= de_max)
        kc = keep.sum(1)
        redo = (kc >= 3) & (kc < cnt)
        if redo.any():
            lin2 = np.where(keep[..., None], lin, np.nan)
            med2 = _nanmedian(lin2, kc)
            med = np.where(redo[:, None], med2, med)
        out[s:e] = linear_to_srgb8(med)
        good[s:e] = cnt >= min_samples
    return out, good


def _nanmedian(lin: np.ndarray, cnt: np.ndarray) -> np.ndarray:
    """Median over axis 1 ignoring NaN (sort puts NaN last); even counts average the two middle values."""
    srt = np.sort(lin, axis=1)
    c = np.maximum(cnt, 1)
    lo = ((c - 1) // 2)[:, None, None]
    hi = (c // 2)[:, None, None]
    a = np.take_along_axis(srt, np.broadcast_to(lo, (len(c), 1, 3)), 1)[:, 0]
    b = np.take_along_axis(srt, np.broadcast_to(hi, (len(c), 1, 3)), 1)[:, 0]
    return np.nan_to_num((a + b) / 2.0)
