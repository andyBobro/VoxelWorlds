"""OSM (Overpass via osmnx) retrieval and feature classification."""
from __future__ import annotations

import math
import os
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, List, Optional

import shapely
from shapely.geometry import MultiPolygon, Polygon

from .. import cache
from ..config import Config
from ..protocol import Cancelled, PipelineError, log

WATER_NATURAL = {"water", "bay"}
WATERWAY_LINES = ("river", "stream", "canal", "drain", "ditch")
VEG_LANDUSE = {"grass", "forest", "meadow", "orchard", "vineyard", "cemetery", "recreation_ground",
               "village_green", "allotments", "farmland", "flowerbed"}
URBAN_LANDUSE = {"residential", "commercial", "retail", "industrial", "construction", "railway",
                 "garages", "brownfield", "education", "institutional"}


_GAP_LOCK = threading.Lock()
_LAST_START = [0.0]
_MIN_GAP_S = 1.0
_BAD_UNTIL: dict = {}  # mirror url -> monotonic time until which it is skipped
_BAD_LOCK = threading.Lock()


class _Either:
    """Event-like view that is set when either the job's cancel event or a local abort event is set."""

    def __init__(self, a: threading.Event, b: threading.Event) -> None:
        self.a, self.b = a, b

    def is_set(self) -> bool:
        return self.a.is_set() or self.b.is_set()

    def wait(self, timeout: Optional[float] = None) -> bool:
        end = None if timeout is None else time.monotonic() + timeout
        while not self.is_set():
            left = 0.1 if end is None else min(0.1, end - time.monotonic())
            if left <= 0:
                break
            self.a.wait(left)
        return self.is_set()


# osmnx reads ox.settings.overpass_url (a process-global) several times per request, so concurrent requests
# may only overlap when they use the SAME mirror; a different mirror waits until the others have finished.
_URL_COND = threading.Condition()
_URL_ACTIVE = {"url": None, "n": 0}


class _MirrorSlot:
    def __init__(self, url: str, stop) -> None:
        self.url, self.stop = url, stop

    def __enter__(self):
        with _URL_COND:
            while _URL_ACTIVE["n"] and _URL_ACTIVE["url"] != self.url:
                if self.stop.is_set():
                    raise Cancelled()
                _URL_COND.wait(0.1)
            _URL_ACTIVE["url"] = self.url
            _URL_ACTIVE["n"] += 1
        return self

    def __exit__(self, *exc) -> None:
        with _URL_COND:
            _URL_ACTIVE["n"] -= 1
            _URL_COND.notify_all()


def _pick_mirror(cfg: Config, attempt: int) -> str:
    """Next mirror in rotation that is not cooling down; if all are, the one that recovers soonest."""
    urls = cfg.overpass_urls
    now = time.monotonic()
    with _BAD_LOCK:
        for k in range(len(urls)):
            u = urls[(attempt + k) % len(urls)]
            if _BAD_UNTIL.get(u, 0.0) <= now:
                return u
        return min(urls, key=lambda u: _BAD_UNTIL.get(u, 0.0))


def _mark_bad(url: str, cfg: Config) -> None:
    with _BAD_LOCK:
        _BAD_UNTIL[url] = time.monotonic() + cfg.overpass_mirror_cooldown_s


def _tags(want_roads: bool) -> dict:
    tags = {
        "building": True,
        "building:part": True,
        "entrance": True,
        "natural": ["water", "wood", "scrub", "grassland", "wetland", "beach", "sand", "tree", "bare_rock",
                    "scree", "heath", "glacier"],
        "barrier": ["fence", "wall", "retaining_wall", "hedge", "city_wall", "guard_rail"],
        "man_made": ["street_lamp", "chimney", "tower", "mast", "communications_tower", "silo", "storage_tank",
                     "water_tower", "lighthouse", "gasometer"],
        "waterway": ["riverbank", "dock", *WATERWAY_LINES],
        "landuse": sorted(VEG_LANDUSE | URBAN_LANDUSE | {"reservoir", "basin", "quarry", "plant_nursery"}),
        "leisure": ["park", "garden", "pitch", "playground", "golf_course"],
    }
    if want_roads:
        tags["highway"] = True
    return tags


def _empty():
    import geopandas as gpd
    return gpd.GeoDataFrame(geometry=[], crs=4326)


def _fetch_chunk(box: tuple, want_roads: bool, cfg: Config, stop: threading.Event):
    """One Overpass query (west, south, east, north) with disk cache and polite retry/backoff."""
    import osmnx as ox
    from osmnx._errors import InsufficientResponseError

    key = "osm|v6-manmade|%.6f,%.6f,%.6f,%.6f|roads=%d" % (*box, int(want_roads))
    hit = cache.get_obj("osm", key, cfg.osm_cache_ttl_s)
    if hit is not None:
        return hit
    ox.settings.log_console = False
    ox.settings.use_cache = True
    ox.settings.cache_folder = os.path.join(tempfile.gettempdir(), "voxelworlds-osm-cache")
    ox.settings.requests_timeout = cfg.overpass_timeout_s
    last: Optional[Exception] = None
    for attempt in range(cfg.overpass_retries):
        if stop.is_set():
            raise Cancelled()
        with _GAP_LOCK:  # space request starts out >= 1 s
            wait = _MIN_GAP_S - (time.monotonic() - _LAST_START[0])
            if wait > 0:
                time.sleep(wait)
            _LAST_START[0] = time.monotonic()
        url = _pick_mirror(cfg, attempt)
        try:
            with _MirrorSlot(url, stop):
                ox.settings.overpass_url = url
                gdf = ox.features_from_bbox(bbox=box, tags=_tags(want_roads))
            cache.put_obj("osm", key, gdf)
            return gdf
        except InsufficientResponseError:
            gdf = _empty()
            cache.put_obj("osm", key, gdf)
            return gdf
        except Exception as e:  # network, 429/504 rate limit, parse
            last = e
            _mark_bad(url, cfg)
            # a different mirror is tried next, so back off only mildly
            delay = min(10.0, 1.5 * (attempt + 1))
            msg = " ".join(str(e).split())[:160]
            log(f"overpass attempt {attempt + 1}/{cfg.overpass_retries} via {url} failed: "
                f"{type(e).__name__}: {msg} (retry in {delay:.0f}s)")
            if attempt + 1 < cfg.overpass_retries and stop.wait(delay):
                raise Cancelled()
    raise PipelineError("OSM_FAILED", f"Overpass request failed on all mirrors: {type(last).__name__}: "
                        f"{' '.join(str(last).split())[:200]}")


def cached_roads_variant(bbox: dict, cfg: Config) -> bool:
    """True when every Overpass chunk of ``bbox`` is in the disk cache with roads=1 (the generate default), so
    a repeat fetch with want_roads=True is a pure cache hit; otherwise callers fall back to roads=0."""
    for box in chunk_boxes(bbox, cfg):
        key = "osm|v6-manmade|%.6f,%.6f,%.6f,%.6f|roads=%d" % (*box, 1)
        if not cache.has("osm", key, cfg.osm_cache_ttl_s):
            return False
    return True


def cached_any(bbox: dict, cfg: Config) -> bool:
    """True when every chunk of ``bbox`` is in the disk cache (with or without roads): fetching it again does not
    hit the network, so building data equals what the generate run saw."""
    for box in chunk_boxes(bbox, cfg):
        if not any(cache.has("osm", "osm|v6-manmade|%.6f,%.6f,%.6f,%.6f|roads=%d" % (*box, r), cfg.osm_cache_ttl_s)
                   for r in (1, 0)):
            return False
    return True


def chunk_boxes(bbox: dict, cfg: Config) -> List[tuple]:
    """Split the bbox into near-equal chunks no larger than cfg.overpass_chunk_m (west,south,east,north)."""
    lat_c = (bbox["latMin"] + bbox["latMax"]) / 2.0
    dlat = cfg.overpass_chunk_m / 111_320.0
    dlon = dlat / max(0.05, math.cos(math.radians(lat_c)))
    ny = max(1, math.ceil((bbox["latMax"] - bbox["latMin"]) / dlat))
    nx = max(1, math.ceil((bbox["lonMax"] - bbox["lonMin"]) / dlon))
    out = []
    for j in range(ny):
        s0 = bbox["latMin"] + (bbox["latMax"] - bbox["latMin"]) * j / ny
        s1 = bbox["latMin"] + (bbox["latMax"] - bbox["latMin"]) * (j + 1) / ny
        for i in range(nx):
            w0 = bbox["lonMin"] + (bbox["lonMax"] - bbox["lonMin"]) * i / nx
            w1 = bbox["lonMin"] + (bbox["lonMax"] - bbox["lonMin"]) * (i + 1) / nx
            out.append((round(w0, 6), round(s0, 6), round(w1, 6), round(s1, 6)))
    return out


def fetch_features(bbox: dict, want_roads: bool, cfg: Config, stop: threading.Event,
                   on_chunk: Optional[Callable[[int, int], None]] = None):
    """Buildings/parts, optional roads, water, landuse for the bbox as a WGS84 gdf (possibly empty).
    Large boxes are split into chunks fetched with at most cfg.overpass_concurrency concurrent requests;
    responses are cached on disk and features duplicated across chunk borders are dropped by OSM id.
    Raises PipelineError(OSM_FAILED) on network/server failure."""
    import geopandas as gpd
    import pandas as pd

    boxes = chunk_boxes(bbox, cfg)
    frames = []
    done = 0
    local = threading.Event()
    both = _Either(stop, local)
    ex = ThreadPoolExecutor(max_workers=max(1, cfg.overpass_concurrency))
    futs: list = []
    try:
        futs = [ex.submit(_fetch_chunk, b, want_roads, cfg, both) for b in boxes]
        results: dict = {}
        for f in as_completed(futs):  # first failure surfaces immediately; merge order stays by chunk index
            results[futs.index(f)] = f.result()
            done += 1
            if on_chunk:
                on_chunk(done, len(boxes))
        frames = [results[i] for i in range(len(boxes))]
    except BaseException:
        local.set()  # sibling chunks stop retrying / waiting; do not block on in-flight requests
        for f in futs:
            f.cancel()
        ex.shutdown(wait=False, cancel_futures=True)
        raise
    ex.shutdown(wait=True)
    frames = [f for f in frames if len(f)]
    if not frames:
        return _empty()
    if len(frames) == 1:
        return frames[0]
    df = pd.concat(frames)
    df = df[~df.index.duplicated(keep="first")]
    return gpd.GeoDataFrame(df, geometry="geometry", crs=4326)


def _tag(row, key: str) -> Optional[str]:
    try:
        v = row.get(key)
    except Exception:
        return None
    if v is None:
        return None
    try:
        if v != v:  # NaN
            return None
    except Exception:
        pass
    s = str(v).strip()
    return s or None


_NUM = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


def parse_length_m(s: Optional[str]) -> Optional[float]:
    if not s:
        return None
    m = _NUM.search(s)
    if not m:
        return None
    try:
        v = float(m.group(0).replace(",", "."))
    except ValueError:
        return None
    low = s.lower()
    if "ft" in low or "'" in low:
        v *= 0.3048
    return v if v == v and v >= 0 else None


def parse_float(s: Optional[str]) -> Optional[float]:
    return parse_length_m(s.replace("ft", "") if s else s)


def repair(geom):
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        geom = shapely.make_valid(geom)
    return geom


def polygons_of(geom) -> List[Polygon]:
    """Flatten any geometry into valid polygons."""
    geom = repair(geom)
    if geom is None:
        return []
    out: List[Polygon] = []
    if isinstance(geom, Polygon):
        out.append(geom)
    elif hasattr(geom, "geoms"):
        for g in geom.geoms:
            out.extend(polygons_of(g))
    return [p for p in out if not p.is_empty and p.area > 0]
