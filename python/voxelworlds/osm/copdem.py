"""Copernicus GLO-30 DEM from the public AWS Open Data COG tiles (no auth, no extra dependencies).

Each 1x1 degree GeoTIFF is a tiled (1024x1024), deflate + floating-point-predictor COG. Only the internal
tiles that cover the requested points are fetched with HTTP range requests, cached on disk as the original
compressed bytes (so a warm run needs no network), decoded with zlib + numpy, and sampled with a
Catmull-Rom bicubic kernel. GLO-30 is a surface model (roofs / tree canopy are included at ~30 m)."""
from __future__ import annotations

import json
import struct
import threading
import zlib
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional, Tuple

import numpy as np
import requests

from .. import cache
from ..config import Config

_BASE = "https://copernicus-dem-30m.s3.amazonaws.com"
_HDR_BYTES = 32768
_TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8}
_TYPE_FMT = {1: "B", 2: "c", 3: "H", 4: "I", 6: "b", 7: "B", 8: "h", 9: "i", 11: "f", 12: "d", 16: "Q"}


class DemUnavailable(Exception):
    pass


def tile_name(lat_i: int, lon_i: int) -> str:
    lon_i = ((lon_i + 180) % 360) - 180
    ns = "N" if lat_i >= 0 else "S"
    ew = "E" if lon_i >= 0 else "W"
    return f"Copernicus_DSM_COG_10_{ns}{abs(lat_i):02d}_00_{ew}{abs(lon_i):03d}_00_DEM"


def tile_url(name: str) -> str:
    return f"{_BASE}/{name}/{name}.tif"


def _get(session: requests.Session, url: str, rng: Optional[Tuple[int, int]], stop: threading.Event):
    """GET (optionally a byte range) with retries. Returns bytes, or None ONLY for HTTP 404 (no such tile).
    Every other failure (403, 5xx, network, ignored Range header) raises DemUnavailable."""
    last: Optional[Exception] = None
    for attempt in range(4):
        if stop.is_set():
            raise DemUnavailable("cancelled")
        try:
            h = {"Range": f"bytes={rng[0]}-{rng[1]}"} if rng else {}
            r = session.get(url, headers=h, timeout=(8, 40))
            if r.status_code == 404:
                return None
            r.raise_for_status()
            if rng:
                cr = r.headers.get("Content-Range", "")
                if r.status_code != 206 or not cr.startswith(f"bytes {rng[0]}-"):
                    raise DemUnavailable(f"server ignored Range ({r.status_code} {cr!r})")
            return r.content
        except DemUnavailable as e:
            last = e
            break
        except requests.RequestException as e:
            last = e
            stop.wait(0.7 * (attempt + 1))
    raise DemUnavailable(f"{type(last).__name__}: {last}")


def _parse_header(buf: bytes) -> dict:
    """Minimal classic-TIFF IFD0 parser: size, tile layout, offsets, georeferencing."""
    try:
        return _parse_header_unsafe(buf)
    except DemUnavailable:
        raise
    except (IndexError, KeyError, struct.error, ValueError, TypeError) as e:
        raise DemUnavailable(f"bad GeoTIFF header: {type(e).__name__}: {e}")


def _parse_header_unsafe(buf: bytes) -> dict:
    e = "<" if buf[:2] == b"II" else ">"
    if struct.unpack(e + "H", buf[2:4])[0] != 42:
        raise DemUnavailable("not a classic TIFF")
    (off,) = struct.unpack(e + "I", buf[4:8])
    (n,) = struct.unpack(e + "H", buf[off:off + 2])
    tags: Dict[int, tuple] = {}
    for i in range(n):
        tag, typ, cnt = struct.unpack(e + "HHI", buf[off + 2 + i * 12:off + 10 + i * 12])
        raw = buf[off + 10 + i * 12:off + 14 + i * 12]
        size = _TYPE_SIZE.get(typ, 1) * cnt
        if size <= 4:
            data = raw[:size]
        else:
            (p,) = struct.unpack(e + "I", raw)
            if p + size > len(buf):
                raise DemUnavailable("header larger than prefetch")
            data = buf[p:p + size]
        fmt = _TYPE_FMT.get(typ)
        tags[tag] = struct.unpack(e + f"{cnt}{fmt}", data) if fmt else ()
    need = (256, 257, 258, 259, 317, 322, 323, 324, 325, 339, 33550, 33922)
    if any(t not in tags for t in need):
        raise DemUnavailable("unexpected GeoTIFF layout")
    if tags[259][0] not in (8, 32946):
        raise DemUnavailable("unsupported compression")
    if tags[258][0] != 32 or tags[339][0] != 3 or tags[317][0] != 3:
        raise DemUnavailable("unsupported sample format")
    if len(tags[324]) != len(tags[325]) or tags[322][0] <= 0 or tags[323][0] <= 0:
        raise DemUnavailable("inconsistent tile table")
    return {"w": tags[256][0], "h": tags[257][0], "tw": tags[322][0], "th": tags[323][0],
            "offs": list(tags[324]), "cnts": list(tags[325]), "x0": tags[33922][3], "y0": tags[33922][4],
            "dx": tags[33550][0], "dy": tags[33550][1], "be": e == ">"}


class Source:
    """One HTTP session, header memo and a small LRU of decoded 1024^2 tiles shared by every strip of a fetch."""

    def __init__(self, cfg: Config, stop: threading.Event, lru_tiles: int = 12) -> None:
        self.cfg, self.stop = cfg, stop
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "VoxelWorlds/0.1 (open-source; GLO-30 range reads)"
        self._hdr: Dict[str, Optional[dict]] = {}
        self._lru: "OrderedDict[Tuple[str, int], np.ndarray]" = OrderedDict()
        self._lock = threading.Lock()
        self._cap = lru_tiles

    def header(self, name: str) -> Optional[dict]:
        """Parsed header, or None when the tile does not exist (HTTP 404, cached)."""
        with self._lock:
            if name in self._hdr:
                return self._hdr[name]
        key = f"copdem-hdr|{name}"
        raw = cache.get_bytes("demtile", key, self.cfg.dem_cache_ttl_s)
        h: Optional[dict] = None
        found = False
        if raw is not None:
            try:
                h = None if raw == b"missing" else json.loads(raw.decode("utf-8"))
                found = True
            except ValueError:
                cache.delete("demtile", key)
        if not found:
            buf = _get(self.session, tile_url(name), (0, _HDR_BYTES - 1), self.stop)
            if buf is None:
                cache.put_bytes("demtile", key, b"missing")
            else:
                h = _parse_header(buf)
                cache.put_bytes("demtile", key, json.dumps(h).encode("utf-8"))
        with self._lock:
            self._hdr[name] = h
        return h

    def tile(self, name: str, hdr: dict, k: int) -> np.ndarray:
        """Decoded (th, tw) float32 internal tile; validated; a corrupt cache entry is dropped and refetched once."""
        key = f"copdem-tile|{name}|{k}"
        with self._lock:
            hit = self._lru.get((name, k))
            if hit is not None:
                self._lru.move_to_end((name, k))
                return hit
        if not 0 <= k < len(hdr["offs"]):
            raise DemUnavailable(f"tile index {k} out of range for {name}")
        o, c = hdr["offs"][k], hdr["cnts"][k]
        if o <= 0 or c <= 0:
            raise DemUnavailable(f"sparse/empty block {k} in {name}")
        arr = None
        raw = cache.get_bytes("demtile", key, self.cfg.dem_cache_ttl_s)
        if raw is not None:
            try:
                arr = _decode(raw, hdr)
            except Exception:
                cache.delete("demtile", key)
        if arr is None:
            raw = _get(self.session, tile_url(name), (o, o + c - 1), self.stop)
            if raw is None or len(raw) != c:
                raise DemUnavailable(f"short read for {name} tile {k}")
            try:
                arr = _decode(raw, hdr)
            except Exception as e:
                raise DemUnavailable(f"corrupt tile {k} of {name}: {type(e).__name__}")
            cache.put_bytes("demtile", key, raw)
        with self._lock:
            self._lru[(name, k)] = arr
            while len(self._lru) > self._cap:
                self._lru.popitem(last=False)
        return arr


def _decode(raw: bytes, hdr: dict) -> np.ndarray:
    """Bounded deflate + horizontal float predictor (TIFF predictor 3) -> (th, tw) float32."""
    th, tw = hdr["th"], hdr["tw"]
    n = th * tw * 4
    d = zlib.decompressobj()
    data = d.decompress(raw, n)
    if len(data) != n or not d.eof and d.decompress(d.unconsumed_tail, 1):
        raise ValueError("unexpected decompressed size")
    a = np.cumsum(np.frombuffer(data, np.uint8).reshape(th, tw * 4), axis=1, dtype=np.uint8)  # wraps mod 256
    planes = a.reshape(th, 4, tw)             # byte planes, most significant first
    if hdr["be"]:
        return np.ascontiguousarray(planes.transpose(0, 2, 1)).view(">f4").reshape(th, tw).astype(np.float32)
    return np.ascontiguousarray(planes[:, ::-1, :].transpose(0, 2, 1)).view("<f4").reshape(th, tw).copy()


def _cubic_weights(t: np.ndarray) -> List[np.ndarray]:
    """Catmull-Rom weights for taps at -1, 0, +1, +2."""
    t2, t3 = t * t, t * t * t
    return [0.5 * (-t3 + 2 * t2 - t), 0.5 * (3 * t3 - 5 * t2 + 2), 0.5 * (-3 * t3 + 4 * t2 + t),
            0.5 * (t3 - t2)]


def _sample_file(src: Source, name: str, hdr: dict, lon: np.ndarray, lat: np.ndarray,
                 pool: ThreadPoolExecutor) -> np.ndarray:
    """Bicubic-sample one GeoTIFF at (lon, lat); taps are clamped to the REAL raster [0,w-1] x [0,h-1]
    (the COG's padded last tiles are never read)."""
    w, h, tw, th = hdr["w"], hdr["h"], hdr["tw"], hdr["th"]
    fx = np.clip((lon - hdr["x0"]) / hdr["dx"] - 0.5, 0.0, w - 1.000001)  # pixel-centre coordinates
    fy = np.clip((hdr["y0"] - lat) / hdr["dy"] - 0.5, 0.0, h - 1.000001)
    ix, iy = np.floor(fx).astype(np.int64), np.floor(fy).astype(np.int64)
    tx, ty = fx - ix, fy - iy
    ntx, nty = (w + tw - 1) // tw, (h + th - 1) // th
    c0, c1 = max(0, max(0, int(ix.min()) - 1) // tw), min(min(w - 1, int(ix.max()) + 2) // tw, ntx - 1)
    r0, r1 = max(0, max(0, int(iy.min()) - 1) // th), min(min(h - 1, int(iy.max()) + 2) // th, nty - 1)
    futs = {(r, c): pool.submit(src.tile, name, hdr, r * ntx + c)
            for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)}
    win = np.zeros(((r1 - r0 + 1) * th, (c1 - c0 + 1) * tw), np.float32)
    for (r, c), f in futs.items():
        win[(r - r0) * th:(r - r0 + 1) * th, (c - c0) * tw:(c - c0 + 1) * tw] = f.result()
    win[~np.isfinite(win) | (win < -500) | (win > 9000)] = 0.0  # no-data -> sea level
    oy, ox = r0 * th, c0 * tw
    wy, wx = _cubic_weights(ty), _cubic_weights(tx)
    out = np.zeros(lon.shape, np.float64)
    for j in range(4):
        yy = np.clip(iy + (j - 1), 0, h - 1) - oy
        row = np.zeros(lon.shape, np.float64)
        for i in range(4):
            xx = np.clip(ix + (i - 1), 0, w - 1) - ox
            row += wx[i] * win[yy, xx]
        out += wy[j] * row
    return out


def _missing_is_sea(src: Source, la: int, lo: int, lon: np.ndarray, lat: np.ndarray,
                    pool: ThreadPoolExecutor) -> bool:
    """A missing 1-degree tile is open sea in the public bucket, except a few land gaps (Armenia/Azerbaijan).
    Probe the existing 8 neighbours at the nearest edge/corner point for each requested location; any land
    (> 1.5 m) there means this is not sea."""
    if len(lon) > 64:
        sel = np.linspace(0, len(lon) - 1, 64).astype(np.int64)
        lon, lat = lon[sel], lat[sel]
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            nla, nlo = la + dy, lo + dx
            if not -90 <= nla < 90:
                continue
            name = tile_name(nla, ((nlo + 180) % 360) - 180)
            hdr = src.header(name)
            if hdr is None:
                continue
            e = 1e-5
            plon = np.clip(lon, nlo + e, nlo + 1 - e) if dx == 0 else np.full(lon.shape, nlo + (1 - e if dx < 0 else e))
            plat = np.clip(lat, nla + e, nla + 1 - e) if dy == 0 else np.full(lat.shape, nla + (1 - e if dy < 0 else e))
            plon = ((plon + 180.0) % 360.0) - 180.0
            if float(_sample_file(src, name, hdr, plon, plat, pool).max()) > 1.5:
                return False
    return not _probe_land(src, lon, lat)


def _probe_land(src: Source, lon: np.ndarray, lat: np.ndarray) -> bool:
    """Ask the public opentopodata API (SRTM, +-60 deg) about <= 8 of the points; True if any is land (> 1.5 m).
    Unknown (API failure / no coverage) counts as not land - the neighbour probe already ran."""
    sel = np.linspace(0, len(lon) - 1, min(8, len(lon))).astype(np.int64)
    pts = [(round(float(lat[i]), 4), round(float(lon[i]), 4)) for i in sel]
    key = "copdem-probe|" + "|".join(f"{a},{b}" for a, b in pts)
    hit = cache.get_bytes("demtile", key, src.cfg.dem_cache_ttl_s)
    if hit is not None:
        return hit == b"1"
    try:
        r = src.session.get(f"https://api.opentopodata.org/v1/{src.cfg.dem_datasets[0]}",
                            params={"locations": "|".join(f"{a},{b}" for a, b in pts)}, timeout=20)
        r.raise_for_status()
        d = r.json()
        if d.get("status") != "OK":
            return False
        land = any((x.get("elevation") or 0.0) > 1.5 for x in d["results"])
    except Exception:
        return False
    cache.put_bytes("demtile", key, b"1" if land else b"0")
    return land


def sample_with(src: Source, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Elevation (m) at WGS84 points (float64, same shape). Longitudes wrap at +-180. Missing 1-degree tiles
    read as 0 m only when they look like open sea; otherwise (or on any network / format failure) raises
    DemUnavailable so the caller can fall back to another source."""
    shape = lon.shape
    lon = ((lon.ravel() + 180.0) % 360.0) - 180.0
    lat = np.clip(lat.ravel(), -89.999999, 89.999999)
    out = np.zeros(lon.shape, np.float64)
    fl_lat = np.floor(lat).astype(np.int64)
    fl_lon = np.floor(lon).astype(np.int64)
    keys = np.unique(np.stack([fl_lat, fl_lon], 1), axis=0)
    with ThreadPoolExecutor(max_workers=6) as pool:
        for la, lo in keys:
            if src.stop.is_set():
                raise DemUnavailable("cancelled")
            name = tile_name(int(la), int(lo))
            m = (fl_lat == la) & (fl_lon == lo)
            try:
                hdr = src.header(name)
                if hdr is None:
                    if not _missing_is_sea(src, int(la), int(lo), lon[m], lat[m], pool):
                        raise DemUnavailable(f"tile {name} missing but neighbours are land")
                    continue
                out[m] = _sample_file(src, name, hdr, lon[m], lat[m], pool)
            except DemUnavailable:
                raise
            except (IndexError, KeyError, struct.error, ValueError, zlib.error, TypeError) as e:
                raise DemUnavailable(f"{type(e).__name__}: {e}")
    return out.reshape(shape)


def sample(lon: np.ndarray, lat: np.ndarray, cfg: Config, stop: threading.Event) -> np.ndarray:
    """One-shot convenience wrapper around :func:`sample_with`."""
    return sample_with(Source(cfg, stop), lon, lat)
