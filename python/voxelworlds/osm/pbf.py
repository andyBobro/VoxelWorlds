"""OSM data from a LOCAL Geofabrik ``.osm.pbf`` extract (pyosmium) instead of Overpass.

The result is the same GeoDataFrame that ``osm.fetch.fetch_features`` returns for Overpass: WGS84, index
``(element, id)`` sorted, one object column per OSM tag, a ``geometry`` column, the same tag filters
(``fetch._tags``) and the same geometry rules (it reuses osmnx's way/multipolygon/filter helpers), so
buildings.py, layers.py, props.py, tiles.py, detail_scene.py and the building index run unchanged.

Strategy
--------
* Small files (< ``cfg.pbf_index_min_bytes``): every request scans the file (one pass, seconds).
* Larger files: a one-time **spatial index** is built in ``cache_root()/pbfidx`` (cells of ``cfg.pbf_cell_deg``,
  zlib-compressed pickled segments, a TOC at the end of the file). Later bboxes read just the 1..4 cells they
  touch. Correctness never depends on the index: a missing, stale (keyed by regionId + size + mtime), corrupt or
  unbuildable index falls back to the scan.
* Results per bbox are cached (kind ``pbf``) keyed by ``(regionId, size, mtime_ns, bbox, roads)``; the Overpass
  cache keys are untouched.

Extraction (one pass, ``FileProcessor`` with node locations): matching nodes -> points; matching ways ->
LineString, or Polygon for closed ways by osmnx's area-tag rules (``area=no`` respected); matching
``multipolygon``/``boundary`` relations -> member ways assembled with osmnx's linemerge/polygonize/hole logic
(missing members are skipped instead of dropping the relation, so border-clipped extracts keep partial
geometry). Ways that only serve as relation members are kept for assembly but are not features themselves.
"""
from __future__ import annotations

import hashlib
import math
import os
import pickle
import struct
import sys
import threading
import time
import zlib
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

from .. import cache
from ..config import Config
from ..protocol import Cancelled, PipelineError, log

INDEX_VERSION = 1
RESULT_VERSION = "v1"
_MAGIC = b"VWPIDX1\n"
_FOOT = struct.Struct("<QQ8s")
KIND_NODE, KIND_WAY, KIND_REL = 0, 1, 2
_ELEMENT = ("node", "way", "relation")
_FOREVER = 20 * 365 * 86400.0           # pbf-derived cache entries never expire (the key carries file identity)
_BIG_CELLS_REL = 2                      # relation geometries are stored once when they touch more cells than this
_BIG_CELLS = 64                         # a feature touching more cells than this is stored once, not per cell
_FLUSH_RECORDS = 300_000
_POLY_HDR = b"\x01\x03\x00\x00\x00\x01\x00\x00\x00"   # WKB polygon, 1 ring; followed by the linestring body
_RULE_KEYS_IGNORED = ("geometry", "element", "id")

ProgressFn = Callable[[float, str], None]


# ───────────────────────── source description / validation ─────────────────────────

@dataclass(frozen=True)
class PbfSource:
    """A validated local extract. ``sig`` (regionId + size + mtime) keys every derived artefact."""
    region_id: str
    path: str
    size: int
    mtime_ns: int
    kind: str = "pbf"

    @property
    def sig(self) -> str:
        return f"{self.region_id}|{self.size}|{self.mtime_ns}"

    def present(self) -> bool:
        return os.path.isfile(self.path)


def resolve_source(ds: Any, missing_code: str = "BAD_REQUEST") -> Optional[PbfSource]:
    """Params ``dataSource`` -> PbfSource, or None for Overpass / absent. kind 'pbf' needs a non-empty regionId
    and a pbfPath (main-validated, never derived here). A missing file raises ``missing_code`` (generate:
    BAD_REQUEST; detail passes NO_DATA); a directory or other non-file is always BAD_REQUEST."""
    if ds is None:
        return None
    if not isinstance(ds, dict):
        raise PipelineError("BAD_REQUEST", "dataSource must be an object")
    kind = ds.get("kind", "overpass")
    if kind == "overpass":
        return None
    if kind != "pbf":
        raise PipelineError("BAD_REQUEST", f"Unknown dataSource.kind: {str(kind)[:40]}")
    rid, path = ds.get("regionId"), ds.get("pbfPath")
    if not isinstance(rid, str) or not rid.strip():
        raise PipelineError("BAD_REQUEST", "dataSource.regionId is required for kind 'pbf'")
    if not isinstance(path, str) or not path or "\x00" in path:
        raise PipelineError("BAD_REQUEST", "dataSource.pbfPath is required for kind 'pbf'")
    try:
        st = os.stat(path)
    except OSError:
        raise PipelineError(missing_code, "The OSM extract file is missing: download the region again"
                            if missing_code != "BAD_REQUEST" else "dataSource.pbfPath does not exist")
    import stat as _stat
    if not _stat.S_ISREG(st.st_mode):
        raise PipelineError("BAD_REQUEST", "dataSource.pbfPath is not a file")
    return PbfSource(rid.strip(), path, int(st.st_size), int(st.st_mtime_ns))


_HDR_LOCK = threading.Lock()
_HDR: Dict[Tuple[str, int, int], Optional[Tuple[float, float, float, float]]] = {}


def header_box(src: PbfSource) -> Optional[Tuple[float, float, float, float]]:
    """(west, south, east, north) from the pbf header, None when the file has no bbox. Raises PBF_UNREADABLE for
    files osmium cannot open."""
    k = (src.path, src.size, src.mtime_ns)
    with _HDR_LOCK:
        if k in _HDR:
            return _HDR[k]
    try:
        import osmium
        with osmium.io.Reader(src.path, osmium.osm.NOTHING) as rd:
            b = rd.header().box()
            box = None
            if b.valid():
                box = (float(b.bottom_left.lon), float(b.bottom_left.lat),
                       float(b.top_right.lon), float(b.top_right.lat))
    except Exception as e:
        raise PipelineError("PBF_UNREADABLE", f"Cannot read OSM extract ({type(e).__name__}): "
                            f"{' '.join(str(e).split())[:160]}")
    with _HDR_LOCK:
        _HDR[k] = box
    return box


def check_coverage(src: PbfSource, bbox: dict) -> None:
    """PBF_UNREADABLE if the file cannot be opened; PBF_NO_COVERAGE if the bbox lies fully outside the header
    bbox (files without a header bbox are not rejected)."""
    box = header_box(src)
    if box is None:
        return
    w, s, e, n = box
    if bbox["lonMax"] < w or bbox["lonMin"] > e or bbox["latMax"] < s or bbox["latMin"] > n:
        raise PipelineError("PBF_NO_COVERAGE", f"The selected area is outside region '{src.region_id}' "
                            f"(file covers lon {w:.3f}..{e:.3f}, lat {s:.3f}..{n:.3f})")


# ───────────────────────── tag filter / geometry rules (shared with the Overpass path) ─────────────────────────

_SPEC_CACHE: Dict[str, Optional[frozenset]] = {}


def _spec() -> Dict[str, Optional[frozenset]]:
    """key -> allowed values (None = any value); exactly the Overpass query tags incl. highway."""
    if not _SPEC_CACHE:
        from . import fetch
        for k, v in fetch._tags(True).items():
            _SPEC_CACHE[k] = None if v is True else frozenset([v] if isinstance(v, str) else v)
    return _SPEC_CACHE


def _match(tags: dict, spec: Dict[str, Optional[frozenset]]) -> bool:
    for k, allowed in spec.items():
        v = tags.get(k)
        if v is not None and (allowed is None or v in allowed):
            return True
    return False


def _is_polygon(tags: dict) -> bool:
    """osmnx's rule for a closed way: area=no wins, else any tag listed in its polygon-feature table."""
    from osmnx.features import _POLYGON_FEATURES
    if tags.get("area") == "no":
        return False
    for tag in tags.keys() & _POLYGON_FEATURES.keys():
        rule = _POLYGON_FEATURES[tag]["polygon"]
        values = _POLYGON_FEATURES[tag].get("values", set())
        if rule == "all" or (rule == "passlist" and tags[tag] in values) or \
                (rule == "blocklist" and tags[tag] not in values):
            return True
    return False


def _assemble(members: List[Tuple[int, str]], way_geoms: Dict[int, bytes]):
    """osmnx's multipolygon assembly over the available member ways (missing ones are skipped)."""
    import shapely
    from shapely.geometry import MultiLineString, Polygon
    from shapely.ops import linemerge, polygonize
    from osmnx.features import _remove_polygon_holes
    outer_l, outer_p, inner_l, inner_p = [], [], [], []
    for ref, role in members:
        wkb = way_geoms.get(ref)
        if wkb is None:
            continue
        g = shapely.from_wkb(wkb)
        if role == "outer":
            (outer_l if g.geom_type == "LineString" else outer_p).append(g)
        elif role == "inner":
            (inner_l if g.geom_type == "LineString" else inner_p).append(g)
    for lines, polys in ((outer_l, outer_p), (inner_l, inner_p)):
        merged = linemerge(lines)
        if merged.geom_type == "LineString":
            merged = MultiLineString([merged])
        for m in merged.geoms:
            polys += polygonize(m)
    if not outer_p:
        return Polygon()
    return _remove_polygon_holes(outer_p, inner_p)


# ───────────────────────── the extraction pass ─────────────────────────

class _Throttle:
    """Rate-limited, monotone progress callback; the callback may raise Cancelled (job.progress does)."""

    def __init__(self, fn: Optional[ProgressFn], every: float = 0.4) -> None:
        self.fn, self.every, self.t, self.last = fn, every, 0.0, 0.0

    def __call__(self, frac: float, msg: str, force: bool = False) -> None:
        if self.fn is None:
            return
        now = time.monotonic()
        if not force and now - self.t < self.every:
            return
        self.t = now
        self.last = max(self.last, min(1.0, max(0.0, frac)))
        self.fn(self.last, msg)


def _est(is_node: bool, oid: int) -> float:
    """Monotone progress estimate of the main pass from the (sorted) object id: nodes ~60 %, ways ~36 %."""
    if is_node:
        return 0.60 * min(1.0, oid / 1.4e10)
    return 0.60 + 0.36 * min(1.0, oid / 1.5e9)


Rec = Tuple[int, int, dict, bytes]          # (kind, id, tags, wkb); wkb = point / linestring / 1-ring polygon
Emit = Callable[[Rec], None]
Bounds = Tuple[float, float, float, float]

_DIRECT = True        # read tags through pyosmium's C accessors (4x faster); False = public iteration API


def _wkb_bounds(w: bytes) -> Bounds:
    """Bounds of a point / linestring / 1-ring polygon WKB as produced by _extract (not for relations)."""
    import numpy as np
    t = w[1]
    a = np.frombuffer(w, dtype="<f8", offset=5 if t == 1 else 9 if t == 2 else 13)
    x, y = a[0::2], a[1::2]
    return float(x.min()), float(y.min()), float(x.max()), float(y.max())


def _overlaps(b: Bounds, bbox: dict) -> bool:
    return not (b[2] < bbox["lonMin"] or b[0] > bbox["lonMax"] or b[3] < bbox["latMin"] or b[1] > bbox["latMax"])


def _extract(src: PbfSource, cfg: Config, stop, emit: Emit, prog: _Throttle, label: str,
             bbox: Optional[dict] = None) -> None:
    """One pass over the file; ``emit((kind, id, tags, wkb))`` for every feature matching the Overpass tag
    filters (all features when ``bbox`` is None, else only those whose bounds touch it: the scan fallback).
    Raises Cancelled when ``stop`` is set (checked every 64 objects)."""
    import shapely
    import osmium
    spec = _spec()
    keys = tuple(spec)
    path = src.path
    intern = sys.intern
    Node = osmium.osm.Node

    # pass 0: candidate multipolygon relations (reads relations only: ~1 s for a country extract)
    prog(0.0, f"{label}: reading relations", force=True)
    rels: List[Tuple[int, dict, List[Tuple[int, str]]]] = []
    member_ways: set = set()
    kfr = osmium.filter.KeyFilter(*keys)
    n = 0
    for r in osmium.FileProcessor(path, osmium.osm.RELATION).with_filter(kfr):
        n += 1
        if n & 63 == 0 and stop.is_set():
            raise Cancelled()
        tags = {intern(t.k): t.v for t in r.tags}
        if tags.get("type") not in ("multipolygon", "boundary") or not _match(tags, spec):
            continue
        for k in _RULE_KEYS_IGNORED:
            tags.pop(k, None)
        mem = [(int(m.ref), m.role) for m in r.members if m.type == "w"]
        if mem:
            rels.append((int(r.id), tags, mem))
            member_ways.update(ref for ref, _ in mem)
    prog(0.03, f"{label}: scanning ways and nodes", force=True)

    # main pass: nodes (only tagged ones reach Python) and ways, with node locations
    storage = "flex_mem"
    tmp_loc = None
    if src.size >= cfg.pbf_disk_locations_bytes:
        d = os.path.join(cache.cache_root(), "pbfidx")
        os.makedirs(d, mode=0o700, exist_ok=True)
        tmp_loc = os.path.join(d, f"loc-{os.getpid()}-{threading.get_ident()}.tmp")
        storage = f"sparse_file_array,{tmp_loc}"
    kf = osmium.filter.KeyFilter(*keys)
    kf.enable_for(osmium.osm.NODE)       # ways always pass: untagged member ways are needed for relations
    way_geoms: Dict[int, bytes] = {}
    fac = osmium.geom.WKBFactory()
    pack_pt = struct.Struct("<BIdd").pack
    direct = _DIRECT

    def read_tags(o) -> dict:
        if direct:
            d = o._pyosmium_data
            it, nx, out = d.tags_begin(), d.tags_next, {}
            for _ in range(d.tags_size()):
                t = nx(it)
                out[intern(t[0])] = t[1]
            return out
        return {intern(t.k): t.v for t in o.tags}

    def has_key(o, k: str) -> bool:
        return o._pyosmium_data.tags_has_key(k) if direct else k in o.tags

    try:
        pool = osmium.io.ThreadPool()
        with osmium.io.Reader(path, osmium.osm.NODE | osmium.osm.WAY, pool) as reader:
            lh = osmium.NodeLocationsForWays(osmium.index.create_map(storage))
            lh.ignore_errors()
            n = 0
            for o in osmium.OsmFileIterator(reader, lh, kf):
                n += 1
                if n & 63 == 0:
                    if stop.is_set():
                        raise Cancelled()
                    if n & 1023 == 0:
                        prog(0.03 + 0.93 * _est(type(o) is Node, o.id), f"{label}: scanning")
                if type(o) is Node:
                    loc = o.location
                    if not loc.valid():
                        continue
                    lon, lat = loc.lon, loc.lat
                    if bbox is not None and not (bbox["lonMin"] <= lon <= bbox["lonMax"] and
                                                 bbox["latMin"] <= lat <= bbox["latMax"]):
                        continue
                    tags = read_tags(o)
                    if not _match(tags, spec):
                        continue
                    for k in _RULE_KEYS_IGNORED:
                        tags.pop(k, None)
                    emit((KIND_NODE, int(o.id), tags, pack_pt(1, 1, lon, lat)))
                    continue
                oid = int(o.id)
                inmem = oid in member_ways
                if not inmem:
                    for k in keys:
                        if has_key(o, k):
                            break
                    else:
                        continue
                lw = None
                if bbox is not None:                  # scan: reject by geometry before touching the tags
                    try:
                        lw = bytes.fromhex(fac.create_linestring(o))
                    except Exception:
                        continue
                    if not inmem and not _overlaps(_wkb_bounds(lw), bbox):
                        continue
                tags = read_tags(o)
                matched = _match(tags, spec)
                if not matched and not inmem:
                    continue
                if lw is None:
                    try:
                        lw = bytes.fromhex(fac.create_linestring(o))
                    except Exception:       # missing node locations / degenerate way
                        continue
                poly = o.ends_have_same_id() and _is_polygon(tags)
                if poly and (len(lw) - 9) >> 4 < 4:     # osmnx: a degenerate Polygon -> empty geometry -> dropped
                    continue
                gw = _POLY_HDR + lw[5:] if poly else lw
                if inmem:
                    way_geoms[oid] = gw
                if not matched:
                    continue
                if bbox is not None and not _overlaps(_wkb_bounds(lw), bbox):
                    continue
                for k in _RULE_KEYS_IGNORED:
                    tags.pop(k, None)
                emit((KIND_WAY, oid, tags, gw))
    finally:
        if tmp_loc:
            try:
                os.remove(tmp_loc)
            except OSError:
                pass

    # relations -> assembled geometry
    prog(0.96, f"{label}: assembling {len(rels)} relations", force=True)
    for i, (rid, tags, mem) in enumerate(rels):
        if i & 63 == 0 and stop.is_set():
            raise Cancelled()
        try:
            g = _assemble(mem, way_geoms)
        except Exception as e:
            log(f"pbf: relation {rid} skipped ({type(e).__name__})")
            continue
        if g is None or g.is_empty:
            continue
        if bbox is not None and not _overlaps(tuple(float(v) for v in g.bounds), bbox):
            continue
        emit((KIND_REL, rid, tags, shapely.to_wkb(g)))


# ───────────────────────── spatial index ─────────────────────────
#
# File: MAGIC | segment* | zlib(pickle(TOC)) | footer(toc_off, toc_len, MAGIC)
# A segment holds the features of ONE cell in columnar form (see _enc_segment): int32 coordinates in 1e-7 degrees
# (OSM's native precision, so the decoded doubles equal osmium's bit for bit), delta coded and byte-shuffled so
# zlib compresses them ~4x better than raw WKB doubles.

_G_POINT, _G_LINE, _G_POLY, _G_OTHER = 0, 1, 2, 3
_E7 = 1e7


def _enc_segment(items: List[tuple]) -> bytes:
    """items: (code, id, tags, npts, payload); code = kind | gtype << 2; payload = int32 xy bytes
    (gtype point/line/poly) or WKB (gtype other)."""
    import numpy as np
    codes = np.fromiter((it[0] for it in items), np.uint8, len(items))
    ids = np.fromiter((it[1] for it in items), np.int64, len(items))
    npts = np.fromiter((it[3] for it in items), np.int32, len(items))
    xy = np.frombuffer(b"".join([it[4] for it in items if it[0] >> 2 != _G_OTHER]), dtype=np.int32)
    xy = xy.reshape(-1, 2).astype(np.int64)
    d = np.diff(xy, axis=0, prepend=np.zeros((1, 2), np.int64)) if len(xy) else xy
    wide = bool(len(d) and np.abs(d).max() >= 2 ** 31)
    d = d.astype(np.int64 if wide else np.int32).reshape(-1)
    width = 8 if wide else 4
    shuf = d.view(np.uint8).reshape(-1, width).T.tobytes() if len(d) else b""
    seg = {"n": len(items), "codes": codes.tobytes(), "ids": ids.tobytes(), "npts": npts.tobytes(),
           "w": width, "xy": shuf, "tags": [it[2] for it in items],
           "other": [it[4] for it in items if it[0] >> 2 == _G_OTHER]}
    return zlib.compress(pickle.dumps(seg, protocol=4), 1)


def _dec_segment(blob: bytes, bbox: dict, seen: set) -> List[tuple]:
    """Records (kind, id, tags, shapely geometry) of the segment that touch ``bbox`` and are not in ``seen``
    (which is updated)."""
    import numpy as np
    import shapely
    seg = pickle.loads(zlib.decompress(blob))
    n = seg["n"]
    if n == 0:
        return []
    codes = np.frombuffer(seg["codes"], np.uint8)
    ids = np.frombuffer(seg["ids"], np.int64)
    npts = np.frombuffer(seg["npts"], np.int32).astype(np.int64)
    w = seg["w"]
    flat = np.frombuffer(seg["xy"], np.uint8).reshape(w, -1).T.copy().view(np.int32 if w == 4 else np.int64)
    xy = np.cumsum(flat.reshape(-1, 2).astype(np.int64), axis=0) if len(flat) else np.zeros((0, 2), np.int64)
    gt = codes >> 2
    kind = codes & 3
    simple = gt != _G_OTHER
    cnt = np.where(simple, npts, 0)
    starts = np.concatenate(([0], np.cumsum(cnt)[:-1])) if n else np.zeros(0, np.int64)
    keep = np.zeros(n, bool)
    if len(xy):
        si = np.nonzero(simple)[0]
        st = starts[si]
        x0 = np.minimum.reduceat(xy[:, 0], st) / _E7
        x1 = np.maximum.reduceat(xy[:, 0], st) / _E7
        y0 = np.minimum.reduceat(xy[:, 1], st) / _E7
        y1 = np.maximum.reduceat(xy[:, 1], st) / _E7
        hit = (x1 >= bbox["lonMin"]) & (x0 <= bbox["lonMax"]) & (y1 >= bbox["latMin"]) & (y0 <= bbox["latMax"])
        keep[si] = hit
    oi = np.nonzero(~simple)[0]
    others = seg["other"]
    out: List[tuple] = []
    for j, i in enumerate(oi):               # relations: full WKB, test after decoding (few per cell)
        key = (int(kind[i]), int(ids[i]))
        if key in seen:
            continue
        g = shapely.from_wkb(others[j])
        b = g.bounds
        if b[2] >= bbox["lonMin"] and b[0] <= bbox["lonMax"] and b[3] >= bbox["latMin"] and b[1] <= bbox["latMax"]:
            seen.add(key)
            out.append((key[0], key[1], seg["tags"][i], g))
    sel = np.nonzero(keep)[0]
    if len(sel):
        fresh = []
        for i in sel:
            key = (int(kind[i]), int(ids[i]))
            if key not in seen:
                seen.add(key)
                fresh.append(i)
        sel = np.array(fresh, dtype=np.int64)
    if len(sel):
        geoms = [None] * len(sel)
        for g_code, build in ((_G_POINT, "p"), (_G_LINE, "l"), (_G_POLY, "a")):
            m = np.nonzero(gt[sel] == g_code)[0]
            if not len(m):
                continue
            recs = sel[m]
            cn = npts[recs]
            idx = np.concatenate([np.arange(starts[i], starts[i] + npts[i]) for i in recs])
            pts = xy[idx] / _E7
            grp = np.repeat(np.arange(len(recs)), cn)
            if build == "p":
                gs = shapely.points(pts)
            elif build == "l":
                gs = shapely.linestrings(pts, indices=grp)
            else:
                gs = shapely.polygons(shapely.linearrings(pts, indices=grp))
            for pos, g in zip(m, gs):
                geoms[pos] = g
        for pos, i in enumerate(sel):
            out.append((int(kind[i]), int(ids[i]), seg["tags"][i], geoms[pos]))
    return out


class _IndexWriter:
    """Collects records, assigns them to cells in vectorised batches, spills the biggest cell buffers as
    columnar segments when memory use grows."""

    BATCH = 10_000

    def __init__(self, f, cell_deg: float, stop=None) -> None:
        self.f = f
        self.stop = stop
        self.cell_i = max(1, int(round(cell_deg * _E7)))
        self.pending: List[Rec] = []
        self.buf: Dict[Tuple[int, int], list] = {}
        self.n_buf = 0
        self.cells: Dict[Tuple[int, int], List[Tuple[int, int]]] = {}
        self.big_bounds: List[Bounds] = []
        self.big_segs: List[Tuple[int, int]] = []
        self.count = 0
        self.f.write(_MAGIC)

    def add(self, rec: Rec) -> None:
        self.pending.append(rec)
        if len(self.pending) >= self.BATCH:
            self._process()

    def _check(self) -> None:
        if self.stop is not None and self.stop.is_set():
            raise Cancelled()

    def _write(self, blob: bytes) -> Tuple[int, int]:
        off = self.f.tell()
        self.f.write(blob)
        return off, len(blob)

    def _place(self, items_bounds: List[Tuple[tuple, Tuple[int, int, int, int]]]) -> None:
        ci = self.cell_i
        for item, (x0, y0, x1, y1) in items_bounds:
            ix0, ix1, iy0, iy1 = x0 // ci, x1 // ci, y0 // ci, y1 // ci
            limit = _BIG_CELLS_REL if item[0] >> 2 == _G_OTHER else _BIG_CELLS   # raw WKB: never replicate widely
            if (ix1 - ix0 + 1) * (iy1 - iy0 + 1) > limit:
                self.big_bounds.append((x0 / _E7, y0 / _E7, x1 / _E7, y1 / _E7))
                self.big_segs.append(self._write(_enc_segment([item])))
                continue
            for iy in range(iy0, iy1 + 1):
                for ix in range(ix0, ix1 + 1):
                    self.buf.setdefault((ix, iy), []).append(item)
                    self.n_buf += 1

    def _process(self) -> None:
        import numpy as np
        import shapely
        self._check()
        recs, self.pending = self.pending, []
        if not recs:
            return
        self.count += len(recs)
        simple = [r for r in recs if r[0] != KIND_REL]
        placed: List[Tuple[tuple, Tuple[int, int, int, int]]] = []
        if simple:
            bodies, npts, gts = [], [], []
            for r in simple:
                w = r[3]
                t = w[1]
                if t == 1:
                    bodies.append(w[5:]); npts.append(1); gts.append(_G_POINT)
                elif t == 2:
                    bodies.append(w[9:]); npts.append((len(w) - 9) >> 4); gts.append(_G_LINE)
                else:
                    bodies.append(w[13:]); npts.append((len(w) - 13) >> 4); gts.append(_G_POLY)
            ints = np.rint(np.frombuffer(b"".join(bodies), dtype="<f8") * _E7).astype(np.int32).reshape(-1, 2)
            cn = np.array(npts, dtype=np.int64)
            st = np.concatenate(([0], np.cumsum(cn)[:-1]))
            bx0 = np.minimum.reduceat(ints[:, 0], st).tolist()
            bx1 = np.maximum.reduceat(ints[:, 0], st).tolist()
            by0 = np.minimum.reduceat(ints[:, 1], st).tolist()
            by1 = np.maximum.reduceat(ints[:, 1], st).tolist()
            stl = st.tolist()
            for j, r in enumerate(simple):
                s, c = stl[j], npts[j]
                item = (r[0] | (gts[j] << 2), r[1], r[2], c, ints[s:s + c].tobytes())
                placed.append((item, (bx0[j], by0[j], bx1[j], by1[j])))
        for r in recs:
            if r[0] == KIND_REL:
                b = shapely.from_wkb(r[3]).bounds
                item = (KIND_REL | (_G_OTHER << 2), r[1], r[2], 0, r[3])
                placed.append((item, (int(math.floor(b[0] * _E7)), int(math.floor(b[1] * _E7)),
                                      int(math.ceil(b[2] * _E7)), int(math.ceil(b[3] * _E7)))))
        self._place(placed)
        if self.n_buf >= _FLUSH_RECORDS:
            self.flush(_FLUSH_RECORDS // 2)

    def flush(self, target: int = 0) -> None:
        """Write the largest cell buffers until at most ``target`` items stay in memory."""
        for key in sorted(self.buf, key=lambda k: -len(self.buf[k])):
            if self.n_buf <= target:
                break
            self._check()
            items = self.buf.pop(key)
            self.n_buf -= len(items)
            self.cells.setdefault(key, []).append(self._write(_enc_segment(items)))

    def finish(self, meta: dict) -> None:
        self._process()
        self.flush(0)
        toc = {"version": INDEX_VERSION, "cell_i": self.cell_i, "cells": self.cells,
               "big_bounds": self.big_bounds, "big_segs": self.big_segs, "meta": meta}
        blob = zlib.compress(pickle.dumps(toc, protocol=4), 6)
        off = self.f.tell()
        self.f.write(blob)
        self.f.write(_FOOT.pack(off, len(blob), _MAGIC))


class _Index:
    """Read side of the index file."""

    def __init__(self, path: str, toc: dict) -> None:
        self.path, self.toc = path, toc

    @staticmethod
    def open(path: str, expect_sig: Optional[str] = None) -> "_Index":
        with open(path, "rb") as f:
            if f.read(len(_MAGIC)) != _MAGIC:
                raise ValueError("bad index magic")
            f.seek(-_FOOT.size, os.SEEK_END)
            off, ln, magic = _FOOT.unpack(f.read(_FOOT.size))
            if magic != _MAGIC:
                raise ValueError("bad index footer")
            f.seek(off)
            toc = pickle.loads(zlib.decompress(f.read(ln)))
        if toc.get("version") != INDEX_VERSION:
            raise ValueError("index version")
        if expect_sig is not None and toc.get("meta", {}).get("sig") != expect_sig:
            raise ValueError("index belongs to another version of the file")
        return _Index(path, toc)

    def query(self, bbox: dict, stop) -> List[tuple]:
        """Records (kind, id, tags, geometry) whose bounds touch ``bbox`` (exact intersection is tested later)."""
        ci = self.toc["cell_i"]
        ix0, ix1 = math.floor((bbox["lonMin"] * _E7 - 1) / ci), math.floor((bbox["lonMax"] * _E7 + 1) / ci)
        iy0, iy1 = math.floor((bbox["latMin"] * _E7 - 1) / ci), math.floor((bbox["latMax"] * _E7 + 1) / ci)
        cells = self.toc["cells"]
        out: List[tuple] = []
        seen: set = set()
        with open(self.path, "rb") as f:
            def rd(off: int, ln: int) -> None:
                if stop.is_set():
                    raise Cancelled()
                f.seek(off)
                out.extend(_dec_segment(f.read(ln), bbox, seen))
            for iy in range(iy0, iy1 + 1):
                for ix in range(ix0, ix1 + 1):
                    for off, ln in cells.get((ix, iy), ()):
                        rd(off, ln)
            for b, (off, ln) in zip(self.toc["big_bounds"], self.toc["big_segs"]):
                if _overlaps(b, bbox):
                    rd(off, ln)
        return out


_BUILD_LOCKS: Dict[str, threading.Lock] = {}
_BUILD_LOCKS_GUARD = threading.Lock()


INDEX_SUFFIX = ".vwidx"
_PART_MAX_AGE_S = 600.0


def file_sig(src: PbfSource) -> str:
    """Identity of the index content: file size + mtime + format version (the regionId is NOT part of it)."""
    return f"{INDEX_VERSION}|{src.size}|{src.mtime_ns}"


def _fallback_path(src: PbfSource) -> str:
    h = hashlib.sha1(os.path.realpath(src.path).encode("utf-8", "surrogateescape")).hexdigest()
    d = os.path.join(cache.cache_root(), "pbfidx")
    os.makedirs(d, mode=0o700, exist_ok=True)
    return os.path.join(d, h + INDEX_SUFFIX)


def index_candidates(src: PbfSource) -> List[str]:
    """Where an index may live: next to the pbf (``<pbfPath>.vwidx``, removed together with it) and, when that
    directory is not writable, ``cache_root()/pbfidx/<sha1(realpath)>.vwidx``."""
    return [src.path + INDEX_SUFFIX, _fallback_path(src)]


def _writable_dir(path: str) -> bool:
    return os.access(os.path.dirname(os.path.abspath(path)) or ".", os.W_OK)


def index_path(src: PbfSource) -> str:
    """Existing index location if any, else the place a new one is built (sibling when writable)."""
    sib, fb = index_candidates(src)
    for c in (sib, fb):
        if os.path.isfile(c):
            return c
    return sib if _writable_dir(sib) else fb


def _pid_alive(pid: int) -> bool:
    if os.name != "posix":
        return False                   # no cheap safe probe: rely on the age check alone
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def sweep_stale_parts(src: PbfSource, now: Optional[float] = None) -> int:
    """Delete abandoned ``<index>.<pid>.<tid>.part`` files (older than 10 min and not owned by a live process)
    next to the pbf and in the fallback directory. Returns how many were removed."""
    now = time.time() if now is None else now
    removed = 0
    for base in index_candidates(src):
        d, name = os.path.split(base)
        try:
            names = os.listdir(d or ".")
        except OSError:
            continue
        for fn in names:
            if not (fn.startswith(name + ".") and fn.endswith(".part")):
                continue
            fp = os.path.join(d, fn)
            try:
                if now - os.path.getmtime(fp) < _PART_MAX_AGE_S:
                    continue
                parts = fn[len(name) + 1:-5].split(".")
                if len(parts) == 2 and parts[0].isdigit() and int(parts[0]) != os.getpid() and \
                        _pid_alive(int(parts[0])):
                    continue
                os.remove(fp)
                removed += 1
            except OSError:
                pass
    return removed


def build_index(src: PbfSource, cfg: Config, stop, prog: _Throttle) -> str:
    """Build (atomically, replacing a stale index) the index for ``src``; returns its path. A cancelled or failed
    build removes its temp file before the exception leaves this function."""
    path = index_path(src)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.part"
    t0 = time.time()
    try:
        try:
            f = open(tmp, "wb")
        except OSError:                       # read-only pbf directory: use the cache directory
            path = _fallback_path(src)
            tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.part"
            f = open(tmp, "wb")
        with f:
            w = _IndexWriter(f, cfg.pbf_cell_deg, stop)
            _extract(src, cfg, stop, w.add, prog, "Indexing region (one-time)")
            prog(0.98, "Indexing region: writing index", force=True)
            w.finish({"sig": file_sig(src), "records": w.count, "build_s": round(time.time() - t0, 1),
                      "built": time.time()})
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    log(f"pbf: index built for {src.region_id}: {w.count} features, {os.path.getsize(path) / 1e6:.0f} MB, "
        f"{time.time() - t0:.0f} s")
    return path


def _open_valid(src: PbfSource) -> Optional[_Index]:
    """First candidate holding a readable index for exactly this file identity; unusable ones are removed."""
    for c in index_candidates(src):
        if not os.path.isfile(c):
            continue
        try:
            return _Index.open(c, file_sig(src))
        except Exception as e:
            log(f"pbf: index {os.path.basename(c)} unusable ({type(e).__name__}: {e}); rebuilding")
            try:
                os.remove(c)
            except OSError:
                pass
    return None


def ensure_index(src: PbfSource, cfg: Config, stop, prog: _Throttle) -> Optional[_Index]:
    """Open the index, building it first when missing/stale/corrupt. None when it cannot be built (caller scans)."""
    key = os.path.realpath(src.path)
    with _BUILD_LOCKS_GUARD:
        lock = _BUILD_LOCKS.setdefault(key, threading.Lock())
    while not lock.acquire(timeout=0.1):     # another job is building it: wait cancellably, then reuse
        if stop.is_set():
            raise Cancelled()
    try:
        sweep_stale_parts(src)
        idx = _open_valid(src)
        if idx is not None:
            return idx
        try:
            return _Index.open(build_index(src, cfg, stop, prog), file_sig(src))
        except (Cancelled, PipelineError):
            raise
        except Exception as e:
            log(f"pbf: index build failed ({type(e).__name__}: {e}); scanning instead")
            return None
    finally:
        lock.release()


def has_index(src: PbfSource) -> bool:
    return any(os.path.isfile(c) for c in index_candidates(src))


# ───────────────────────── public: fetch / cache ─────────────────────────

def _key(src: PbfSource, bbox: dict, want_roads: bool) -> str:
    return "pbf|%s|%s|%.6f,%.6f,%.6f,%.6f|roads=%d" % (RESULT_VERSION, src.sig, bbox["lonMin"], bbox["latMin"],
                                                       bbox["lonMax"], bbox["latMax"], int(want_roads))


def cached_roads_variant(bbox: dict, src: PbfSource) -> bool:
    """Which variant detail should load. roads=1 cached -> True; only roads=0 cached -> False (matches what
    generate saw); nothing cached -> True (the bbox is rebuilt locally from the file, roads included)."""
    if cache.has("pbf", _key(src, bbox, True), _FOREVER):
        return True
    return not cache.has("pbf", _key(src, bbox, False), _FOREVER)


def cached_any(bbox: dict, src: PbfSource) -> bool:
    """A pbf bbox never needs the network: it is a cache hit or can be rebuilt from the file, so it is available
    exactly when the file is."""
    return src.present()


def _empty():
    import geopandas as gpd
    return gpd.GeoDataFrame(geometry=[], crs=4326)


def _to_gdf(recs: List[tuple], bbox: dict, want_roads: bool):
    """Records (kind, id, tags, geometry) -> the frame osmnx.features_from_bbox gives (same filter/validity code)."""
    import geopandas as gpd
    from shapely.geometry import box as sbox
    from osmnx._errors import InsufficientResponseError
    from osmnx.features import _filter_features
    from . import fetch
    if not recs:
        return _empty()
    rows = []
    for kind, oid, tags, g in sorted(recs, key=lambda r: (_ELEMENT[r[0]], r[1])):     # path-independent order
        d = {"element": _ELEMENT[kind], "id": oid}
        d.update(tags)
        d["geometry"] = g
        rows.append(d)
    gdf = gpd.GeoDataFrame(rows, geometry="geometry", crs=4326).set_index(["element", "id"]).sort_index()
    try:
        return _filter_features(gdf, sbox(bbox["lonMin"], bbox["latMin"], bbox["lonMax"], bbox["latMax"]),
                                fetch._tags(want_roads))
    except InsufficientResponseError:
        return _empty()


def fetch_features(bbox: dict, want_roads: bool, cfg: Config, stop, src: PbfSource,
                   on_progress: Optional[ProgressFn] = None):
    """GeoDataFrame for ``bbox`` from the local extract (cache -> index -> scan). Raises PBF_UNREADABLE for
    unreadable/corrupt files, PBF_NO_COVERAGE when the bbox is outside the file, Cancelled on cancel."""
    import shapely
    prog = _Throttle(on_progress)
    key = _key(src, bbox, want_roads)
    hit = cache.get_obj("pbf", key, _FOREVER)
    if hit is not None:
        prog(1.0, "Region data cached", force=True)
        return hit
    if not src.present():
        raise PipelineError("NO_DATA", "The OSM extract file is missing: download the region again")
    check_coverage(src, bbox)
    try:
        recs: Optional[List[tuple]] = None
        if src.size >= cfg.pbf_index_min_bytes:
            idx = ensure_index(src, cfg, stop, prog)
            if idx is not None:
                prog(0.99, "Reading region index", force=True)
                recs = idx.query(bbox, stop)
        if recs is None:
            out: Dict[Tuple[int, int], Rec] = {}

            def keep(rec: Rec) -> None:
                out.setdefault((rec[0], rec[1]), rec)

            _extract(src, cfg, stop, keep, prog, "Scanning region file", bbox)
            recs = [(r[0], r[1], r[2], shapely.from_wkb(r[3])) for r in out.values()]
        gdf = _to_gdf(recs, bbox, want_roads)
    except (Cancelled, PipelineError):
        raise
    except MemoryError:
        raise
    except Exception as e:
        log(f"pbf: read failed: {type(e).__name__}: {e}")
        raise PipelineError("PBF_UNREADABLE", f"Cannot read OSM extract ({type(e).__name__}): "
                            f"{' '.join(str(e).split())[:160]}")
    cache.put_obj("pbf", key, gdf)
    prog(1.0, f"Region data: {len(gdf)} features", force=True)
    return gdf
