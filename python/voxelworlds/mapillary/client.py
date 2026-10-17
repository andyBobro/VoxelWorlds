"""Mapillary Graph API v4: image search, thumbnails, and wall-colour sampling."""
from __future__ import annotations

import io
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

import numpy as np
import requests

from .. import cache
from ..config import Config
from ..protocol import log
from ..voxel.grid import Grid

TILE_URL = "https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}"
GRAPH_URL = "https://graph.mapillary.com/{id}"
ZOOM = 14
MARGIN_DEG = 0.0005  # cameras just outside the bbox can still see its walls


@dataclass
class Images:
    ids: List[str]
    e: np.ndarray
    n: np.ndarray
    heading: np.ndarray  # radians, clockwise from north
    urls: List[str]  # resolved lazily via resolve_urls(); "" = unresolved/unavailable
    captured: Optional[np.ndarray] = None  # capture time (ms since epoch, 0 = unknown); optional
    urls_alt: Optional[List[str]] = None   # fallback-resolution urls

    def __len__(self) -> int:
        return len(self.ids)


def _tile_xy(lat: float, lon: float, z: int):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def fetch_images(bbox: dict, token: str, grid: Grid, to_utm, cfg: Config) -> Optional[Images]:
    """Image positions/headings from the public vector tiles (z14 'image' layer).
    Returns None when nothing usable. Raises on network failure (caller degrades)."""
    import mapbox_vector_tile

    x0, y1 = _tile_xy(bbox["latMin"] - MARGIN_DEG, bbox["lonMin"] - MARGIN_DEG, ZOOM)
    x1, y0 = _tile_xy(bbox["latMax"] + MARGIN_DEG, bbox["lonMax"] + MARGIN_DEG, ZOOM)
    tiles = [(tx, ty) for tx in range(int(x0), int(x1) + 1) for ty in range(int(y0), int(y1) + 1)]
    if len(tiles) > cfg.mapillary_max_tiles:
        raise RuntimeError("area too large for Mapillary tile search")
    n_tiles = 2 ** ZOOM
    sess = requests.Session()
    found: Dict[str, tuple] = {}
    for tx, ty in tiles:
        content = cache.get_bytes("mly-vt", f"{ZOOM}/{tx}/{ty}", cfg.mapillary_cache_ttl_s)
        if content is None:
            r = sess.get(TILE_URL.format(z=ZOOM, x=tx, y=ty), params={"access_token": token}, timeout=40)
            if r.status_code in (400, 401, 403):
                raise RuntimeError(f"Mapillary rejected the request (HTTP {r.status_code})")
            if r.status_code != 204:
                r.raise_for_status()
            content = r.content or b""
            cache.put_bytes("mly-vt", f"{ZOOM}/{tx}/{ty}", content)
        if not content:
            continue
        layer = mapbox_vector_tile.decode(content).get("image")
        if not layer:
            continue
        ext = float(layer.get("extent", 4096))
        for f in layer["features"]:
            pr = f.get("properties", {})
            g = f.get("geometry", {})
            ang = pr.get("compass_angle")
            if g.get("type") != "Point" or ang is None or pr.get("is_pano") or "id" not in pr:
                continue
            px, py = g["coordinates"]  # y is up (decoder default), i.e. measured from the tile's south edge
            fx = tx + px / ext
            fy = ty + 1 - py / ext
            lon = fx / n_tiles * 360.0 - 180.0
            lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * fy / n_tiles))))
            if (bbox["latMin"] - MARGIN_DEG <= lat <= bbox["latMax"] + MARGIN_DEG and
                    bbox["lonMin"] - MARGIN_DEG <= lon <= bbox["lonMax"] + MARGIN_DEG):
                try:
                    cap = float(pr.get("captured_at") or 0.0)
                except (TypeError, ValueError):
                    cap = 0.0
                found[str(pr["id"])] = (lon, lat, math.radians(float(ang)), cap)
    if not found:
        return None
    ids = list(found)
    lon_l = [found[i][0] for i in ids]
    lat_l = [found[i][1] for i in ids]
    e, n = to_utm.transform(lon_l, lat_l)
    return Images(ids, np.asarray(e), np.asarray(n), np.asarray([found[i][2] for i in ids]),
                  [""] * len(ids), np.asarray([found[i][3] for i in ids]))


def resolve_urls(imgs: Images, token: str, tick: Callable[[float], None], res: int = 256) -> int:
    """Fill imgs.urls (preferred resolution `res` = 256 or 1024; falls back to the other one, recorded in
    imgs.urls_alt) via the Graph API for every image (call on a pre-selected subset)."""
    want, other = ("thumb_1024_url", "thumb_256_url") if res >= 1024 else ("thumb_256_url", "thumb_1024_url")
    imgs.urls_alt = [""] * len(imgs)

    def one(i: int):
        try:
            r = requests.get(GRAPH_URL.format(id=imgs.ids[i]),
                             params={"fields": f"{want},{other}"},
                             headers={"Authorization": f"OAuth {token}"}, timeout=20)
            r.raise_for_status()
            j = r.json()
            return i, j.get(want) or "", j.get(other) or ""
        except Exception as e:
            if i == 0:
                log(f"mapillary image lookup failed: {type(e).__name__} (further failures suppressed)")
            return i, "", ""

    done = ok = 0
    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, u, alt in ex.map(one, range(len(imgs))):
            imgs.urls[i] = u or alt
            imgs.urls_alt[i] = alt if u else ""
            done += 1
            ok += bool(u or alt)
            tick(done / max(1, len(imgs)))
    return ok


def select_images(imgs: Images, seg_mid: np.ndarray, seg_nrm: np.ndarray, cfg: Config,
                  n_best: int = 1) -> np.ndarray:
    """For each wall segment (K,2 E/N midpoints; K,2 outward normals) pick up to `n_best` image indices
    (K, n_best), best first, -1 padded. Score (lower is better) = distance x facing-the-wall x camera-looking-at-
    the-wall x age; candidates must be 3..max_distance m away, in front of the wall (|incidence| < ~70 deg) and
    pointing at it (within 40 deg). Panoramas are already dropped at search time."""
    K = len(seg_mid)
    best = np.full((K, n_best), -1, np.int64)
    if K == 0 or len(imgs) == 0:
        return best
    ce, cn = imgs.e[None, :], imgs.n[None, :]
    ve = ce - seg_mid[:, 0:1]
    vn = cn - seg_mid[:, 1:2]
    d = np.hypot(ve, vn) + 1e-6
    front = (ve * seg_nrm[:, 0:1] + vn * seg_nrm[:, 1:2]) / d
    de, dn = np.sin(imgs.heading)[None, :], np.cos(imgs.heading)[None, :]
    looking = -(ve * de + vn * dn) / d
    ok = (d <= cfg.mapillary_max_distance_m) & (d >= 3.0) & (front > 0.35) & (looking > math.cos(math.radians(40)))
    score = d * (2.0 - front) * (2.0 - looking)
    cap = getattr(imgs, "captured", None)
    if cap is not None and len(cap) and float(np.max(cap)) > 0:
        ref = float(np.max(cap))
        age_y = np.where(cap > 0, (ref - cap) / 3.156e10, 5.0)  # unknown date counts as 5 years old
        score = score * (1.0 + 0.06 * np.clip(age_y, 0.0, 10.0))[None, :]
    score = np.where(ok, score, np.inf)
    n = min(n_best, score.shape[1])
    idx = np.argpartition(score, n - 1, axis=1)[:, :n] if score.shape[1] > n else \
        np.tile(np.arange(score.shape[1]), (K, 1))
    sc = np.take_along_axis(score, idx, 1)
    o = np.argsort(sc, axis=1, kind="stable")
    idx, sc = np.take_along_axis(idx, o, 1), np.take_along_axis(sc, o, 1)
    best[:, :n] = np.where(np.isfinite(sc), idx, -1)
    return best


def download_thumbs(imgs: Images, wanted: List[int], tick: Callable[[float], None],
                    max_side: int = 256) -> Dict[int, np.ndarray]:
    """Download thumbnails; returns {image index: uint8 (h, w, 4) RGB + facade alpha}, downscaled so the
    longer side is <= max_side (never upscaled)."""
    from PIL import Image
    from .sampling import prepare_thumb

    def one(i: int):
        try:
            if not imgs.urls[i]:
                return i, None
            r = requests.get(imgs.urls[i], timeout=30)
            r.raise_for_status()
            im = Image.open(io.BytesIO(r.content)).convert("RGB")
            if max(im.size) > max_side:
                im.thumbnail((max_side, max_side), Image.BOX)
            return i, prepare_thumb(np.asarray(im, dtype=np.uint8))
        except Exception as e:
            log(f"thumb download failed: {type(e).__name__}")
            return i, None

    out: Dict[int, np.ndarray] = {}
    done = 0
    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, arr in ex.map(one, wanted):
            done += 1
            tick(done / max(1, len(wanted)))
            if arr is not None:
                out[i] = arr
    return out
