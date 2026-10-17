"""Building extraction from OSM features and voxelization into wall/roof shells."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

import numpy as np
import shapely
from shapely.geometry import Polygon
from shapely.geometry.polygon import orient

from ..config import Config
from ..protocol import PipelineError
from ..osm.fetch import _tag, parse_float, parse_length_m, polygons_of
from . import colours, facade, roofdetail, roofs
from .grid import Grid, cells_in_geom
from .terrain import Terrain, ground_points


@dataclass
class Building:
    key: str
    poly: Polygon
    height_m: float
    min_height_m: float
    kind: str
    wall_tag: Optional[tuple]
    roof_tag: Optional[tuple]
    btype: Optional[str] = None
    roof: roofs.RoofSpec = field(default_factory=roofs.RoofSpec)
    wall_mat: Optional[str] = None
    roof_mat: Optional[str] = None
    # voxel results
    base_y: int = 0
    wx: np.ndarray = field(default_factory=lambda: np.empty(0, np.int32))
    wy: np.ndarray = field(default_factory=lambda: np.empty(0, np.int32))
    wz: np.ndarray = field(default_factory=lambda: np.empty(0, np.int32))
    rx: np.ndarray = field(default_factory=lambda: np.empty(0, np.int32))
    ry: np.ndarray = field(default_factory=lambda: np.empty(0, np.int32))
    rz: np.ndarray = field(default_factory=lambda: np.empty(0, np.int32))
    wall_rgb: Optional[np.ndarray] = None
    roof_rgb: tuple = (120, 90, 80)
    photo: bool = False
    seg_sel: Optional[np.ndarray] = None  # per wall segment: Mapillary camera index or -1
    owner: Optional[tuple] = None
    entrances: list = field(default_factory=list)  # (easting, northing) of entrance=* nodes on/near the outline
    party_lo: Optional[np.ndarray] = None  # lower bound (m) of the party-wall height interval per segment
    party_h: Optional[np.ndarray] = None  # per raw outline segment: height (m) of the tallest neighbour touching it
    eave_y: Optional[int] = None                       # y of the first roof layer above the walls (flat roof: the roof slab)
    rk: Optional[np.ndarray] = None       # per roof voxel kind (roofdetail.K_*), parallel to rx/ry/rz
    roof_rgb_arr: Optional[np.ndarray] = None  # per roof voxel colours (fine voxel sizes)
    rmax_v: int = 0                       # roof height in voxels above the eave
    facade_texture: bool = True
    lat_ref: Optional[tuple] = None
    reach: Optional[Polygon] = None  # footprint + area its voxels may reach (tilted lattice legs); used for tile queries
    lattice: bool = False
    open_structure: bool = False          # building=roof/carport/...: pillars + roof only
    idx_key: Optional[str] = None         # key of the piece (building) this volume belongs to; parts -> their parent

    @property
    def count(self) -> int:
        return len(self.wx) + len(self.rx)


# man_made structures rendered as buildings: value -> (radius m for nodes, wall material, default roof shape)
MAN_MADE = {"chimney": (1.4, "brick", "flat"), "tower": (2.2, "concrete", "flat"), "mast": (0.6, "steel", "flat"),
            "communications_tower": (1.0, "steel", "flat"), "silo": (4.0, "concrete", "dome"),
            "storage_tank": (5.0, "metal", "flat"), "water_tower": (4.0, "concrete", "dome"),
            "lighthouse": (3.0, "plaster", "cone"), "gasometer": (8.0, "metal", "dome")}
OPEN_TYPES = {"roof", "carport", "pavilion", "gazebo", "shelter", "canopy", "bandstand", "grandstand_roof"}
_KIND_TYPICAL = {"commercial": 12.0, "industrial": 8.0, "religious": 15.0, "civic": 12.0, "minor": 3.5}


@dataclass
class _Piece:
    key: str
    poly: Polygon
    is_part: bool
    h: Optional[float]
    lv: Optional[float]
    mh: float
    kind: str
    btype: Optional[str]
    wc: Optional[tuple]
    rc: Optional[tuple]
    rt: dict
    wmat: Optional[str]
    rmat: Optional[str]
    parent: int = -1  # index into pieces of the building a part belongs to
    lat_ref: Optional[tuple] = None  # (centre E, centre N, total height m) of the big lattice a part belongs to
    lattice: bool = False  # tower:construction=lattice (or inherited from the lattice building a part sits in)
    mm_node: bool = False  # man_made node (no height) turned into a small footprint
    name: Optional[str] = None
    origin: str = ""  # key of the piece this one was derived from (remainders of a parent)


def _clean_remainder(rem, orig_area: float) -> List[Polygon]:
    """Parent outline minus its parts: drop slivers (< ~1.2 m wide) and negligible leftovers."""
    if rem is None or rem.is_empty:
        return []
    try:
        opened = rem.buffer(-0.6).buffer(0.6)
        cand = polygons_of(opened) if not opened.is_empty else []
    except Exception:
        cand = polygons_of(rem)
    return [q for q in cand if q.area >= max(6.0, 0.04 * orig_area)]


def extract_buildings(gdf_utm, cfg: Config, mpf: float, default_h: float,
                      check: Optional[Callable[[], None]] = None,
                      index_out: Optional[list] = None) -> List[Building]:
    """gdf_utm: features in UTM CRS. Returns whole buildings (polygons incl. interior rings / courtyards).

    * building:part features are rendered as their own volumes (own height / min_height / roof / colours,
      inheriting colours, materials, type and a missing height from the building they sit in); the parent
      outline is reduced to the area NOT covered by parts (no double volumes).
    * Height priority: height tag > building:levels x metersPerFloor (+ roof) > fallback by building type,
      blended with the median of explicit-height buildings within cfg.neighbor_radius_m, with deterministic
      per-building jitter."""
    if gdf_utm.empty:
        return []
    cols = set(gdf_utm.columns)
    has_b = "building" in cols
    has_p = "building:part" in cols
    has_m = "man_made" in cols
    pieces: List[_Piece] = []
    for n_row, (idx, row) in enumerate(gdf_utm.iterrows()):
        if check is not None and n_row % 256 == 0:
            check()
        g = lambda k: (_tag(row, k) if k in cols else None)
        isb = has_b and g("building") is not None
        isp = has_p and g("building:part") not in (None, "no")
        mm = g("man_made") if has_m else None
        ism = mm in MAN_MADE and not (isb or isp)
        if not (isb or isp or ism):
            continue
        if isb and g("building") == "no":
            continue
        geom = row.geometry
        is_node = False
        if geom is not None and ism and geom.geom_type == "Point":  # chimney / mast / tower nodes
            geom = geom.buffer(MAN_MADE[mm][0], 8)
            is_node = True
        elif geom is not None and ism and geom.geom_type in ("Polygon", "MultiPolygon"):
            # polygon extrusion only for compact round-ish structures; lattice / large-footprint towers
            # (Eiffel Tower: 125 x 330 m) must not become solid boxes
            if mm in ("tower", "mast", "communications_tower") and (
                    geom.area > 150.0 or (g("tower:construction") or "") == "lattice"):
                continue
        if geom is None or geom.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        polys = polygons_of(geom)
        if not polys:
            continue
        tags = {k: g(k) for k in ("building", "amenity", "shop", "office", "tourism", "building:use")}
        btype = g("building") if isb else (g("building:part") if isp else mm)
        h = parse_length_m(g("height"))
        lv = parse_float(g("building:levels"))
        mh = parse_length_m(g("min_height")) or 0.0
        if not mh and g("building:min_level"):
            mh = (parse_float(g("building:min_level")) or 0.0) * mpf
        wc = None
        for k in ("building:colour", "building:facade:colour", "colour"):
            wc = colours.parse_colour(g(k))
            if wc is not None:
                break
        rc = colours.parse_colour(g("roof:colour"))
        wmat = None
        for k in ("building:material", "building:facade:material", "building:cladding"):
            wmat = colours.wall_material(g(k))
            if wmat is not None:
                break
        rmat = colours.roof_material(g("roof:material"))
        if btype == "greenhouse":
            wmat, rmat = wmat or "glass", rmat or "glass"
        kind = facade.building_kind(tags)
        if ism:
            kind, wmat = "minor", wmat or MAN_MADE[mm][1]
        if btype in OPEN_TYPES:
            kind = "minor"
        lat = (g("tower:construction") or "") in ("lattice", "framework", "truss") and not isp
        key = "/".join(str(i) for i in (idx if isinstance(idx, tuple) else (idx,)))
        rt = dict(shape=g("roof:shape") or (MAN_MADE[mm][2] if ism else None), height=parse_length_m(g("roof:height")),
                  levels=parse_float(g("roof:levels")), direction=roofs.parse_bearing(g("roof:direction")),
                  orientation=g("roof:orientation"))
        nm = g("name") if "name" in cols else None
        for i, p in enumerate(polys):
            pieces.append(_Piece(f"{key}#{i}", p, isp and not isb, h, lv, mh, kind, btype, wc, rc, rt,
                                 wmat, rmat, lattice=lat, mm_node=bool(is_node and h is None), name=nm))

    # ---- stand-alone man_made nodes without a height that lie inside a building: skip (not on its roof)
    nodes = [i for i, pc in enumerate(pieces) if pc.mm_node]
    if nodes:
        bi = [i for i, pc in enumerate(pieces) if not pc.mm_node and not pc.is_part and pc.btype not in MAN_MADE]
        if bi:
            btr = shapely.STRtree([pieces[i].poly for i in bi])
            drop = set()
            for i in nodes:
                c = pieces[i].poly.representative_point()
                if len(btr.query(c, predicate="within")):
                    drop.add(i)
            if drop:
                pieces = [pc for i, pc in enumerate(pieces) if i not in drop]

    # ---- building index records (whole footprints, before parts split them): non-part pieces + parent-less parts
    if index_out is not None:
        for pc in pieces:
            if not pc.is_part:
                index_out.append(dict(key=pc.key, poly=pc.poly, kind=pc.kind, lv=pc.lv, name=pc.name))

    # ---- building:part handling
    part_ix = [i for i, pc in enumerate(pieces) if pc.is_part]
    if part_ix:
        parent_ix = [i for i, pc in enumerate(pieces) if not pc.is_part]
        ptree = shapely.STRtree([pieces[i].poly for i in parent_ix]) if parent_ix else None
        for n_p, i in enumerate(part_ix):  # which building does each part sit in? (largest overlap, >= 50% of the part)
            if check is not None and n_p % 256 == 0:
                check()
            pc = pieces[i]
            if ptree is None or pc.poly.area <= 0:
                continue
            best, best_a = -1, 0.0
            for j in ptree.query(pc.poly):
                try:
                    a = pc.poly.intersection(pieces[parent_ix[int(j)]].poly).area
                except Exception:
                    continue
                if a > best_a:
                    best, best_a = parent_ix[int(j)], a
            if best >= 0 and best_a >= 0.5 * pc.poly.area:
                pc.parent = best
        part_polys = [pieces[i].poly for i in part_ix]
        part_tree = shapely.STRtree(part_polys)
        kept: List[_Piece] = []
        remap: Dict[int, int] = {}
        for i, pc in enumerate(pieces):
            if check is not None and i % 256 == 0:
                check()
            if pc.is_part:
                par = pieces[pc.parent] if pc.parent >= 0 else None
                if par is not None:  # inherit what the part does not say itself
                    if pc.wc is None: pc.wc = par.wc
                    if pc.rc is None: pc.rc = par.rc
                    if pc.wmat is None: pc.wmat = par.wmat
                    if pc.rmat is None: pc.rmat = par.rmat
                    if par.lattice:
                        pc.lattice = True
                        if par.h and par.h >= 40.0 and par.poly.area >= 400.0:
                            fc = roofs.frame_of(par.poly)
                            pc.lat_ref = (fc[0], fc[1], float(par.h))
                    if pc.kind == "generic": pc.kind = par.kind
                    if pc.btype in (None, "yes"): pc.btype = par.btype if par.btype not in (None, "yes") else pc.btype
                    if pc.h is None and pc.lv is None:
                        pc.h, pc.lv = par.h, par.lv
                remap[i] = len(kept)
                pc.origin = pieces[pc.parent].key if pc.parent >= 0 else pc.key
                kept.append(pc)
                continue
            p = pc.poly
            try:
                cand = part_tree.query(p, predicate="intersects")
                hit = len(cand) > 0
                part_union = shapely.union_all([part_polys[int(j)] for j in sorted(cand)]) if hit else None
                inter = p.intersection(part_union).area if hit else 0.0
            except Exception:
                hit, inter = False, 0.0
            if not hit or inter < 0.02 * p.area:
                pc.origin = pc.key
                kept.append(pc)
                continue
            for n, q in enumerate(_clean_remainder(p.difference(part_union), p.area)):
                kept.append(_Piece(f"{pc.key}~{n}", q, False, pc.h, pc.lv, pc.mh, pc.kind, pc.btype,
                                   pc.wc, pc.rc, pc.rt, pc.wmat, pc.rmat, lattice=pc.lattice, origin=pc.key))
        pieces = kept

    # ---- fallback heights: typical per type, blended with neighbours that have explicit heights
    proxy = []
    pts = []
    for pc in pieces:
        if pc.kind != "minor" and pc.poly.area >= 30.0:
            if pc.h is not None and pc.h > 0:
                proxy.append(pc.h)
            elif pc.lv is not None and pc.lv > 0:
                proxy.append(pc.lv * mpf + 2.0)
            else:
                continue
            pts.append(pc.poly.representative_point())
    ntree = shapely.STRtree(pts) if pts else None
    proxy_a = np.asarray(proxy, float)
    out: List[Building] = []
    for n_pc, pc in enumerate(pieces):
        if check is not None and n_pc % 256 == 0:
            check()
        explicit = (pc.h is not None and pc.h > 0) or (pc.lv is not None and pc.lv > 0)
        fb = default_h
        if not explicit:
            typ = cfg.typical_heights.get(pc.btype or "") if pc.btype else None
            if typ is None:
                typ = _KIND_TYPICAL.get(pc.kind, default_h)
            fb = typ
            if ntree is not None and pc.kind != "minor":
                c = pc.poly.representative_point()
                near = ntree.query(c.buffer(cfg.neighbor_radius_m))
                if len(near):
                    near = [int(k) for k in near if pts[int(k)].distance(c) <= cfg.neighbor_radius_m]
                if len(near):
                    med = float(np.median(proxy_a[near]))
                    generic = pc.btype in (None, "yes", "building")
                    w = (0.7 if len(near) >= 3 else 0.5) if generic else (0.5 if len(near) >= 3 else 0.3)
                    fb = (1 - w) * typ + w * med
            u = roofs._h(pc.key, cfg.seed, 3)
            fb = round(fb * (1.0 + (2.0 * u - 1.0) * cfg.height_jitter) * 2.0) / 2.0
            fb = max(fb, 2.5)
        p = orient(pc.poly, 1.0)
        total, mh2, spec = resolve_height_and_roof(pc.key, p, pc.h, pc.lv, pc.mh, pc.rt, pc.btype, mpf,
                                                   fb, cfg)
        bl = Building(pc.key, p, total, mh2, pc.kind, pc.wc, pc.rc, pc.btype, spec, pc.wmat, pc.rmat)
        bl.lattice = pc.lattice
        bl.idx_key = pc.origin or pc.key
        bl.lat_ref = pc.lat_ref
        if pc.lat_ref is not None:
            from shapely import affinity
            sc_end = 0.07  # legs converge at most to 7 % of their distance from the tower axis
            bb = shapely.box(*p.bounds)
            bl.reach = shapely.union_all([bb, affinity.scale(bb, sc_end, sc_end, origin=(pc.lat_ref[0], pc.lat_ref[1]))]).convex_hull
        out.append(bl)
    _attach_entrances(gdf_utm, cols, out)
    _attach_party_walls(out)
    return out


def raw_segments(poly: Polygon):
    """All outline segments (exterior ring first, then courtyard rings), unfiltered, with outward normals
    (the building is oriented: exterior CCW, interiors CW)."""
    rings = [np.asarray(poly.exterior.coords)] + [np.asarray(r.coords) for r in poly.interiors]
    p0 = np.concatenate([r[:-1] for r in rings])
    p1 = np.concatenate([r[1:] for r in rings])
    ring_id = np.concatenate([np.full(len(r) - 1, i, np.int32) for i, r in enumerate(rings)])
    d = p1 - p0
    L = np.hypot(d[:, 0], d[:, 1])
    nrm = np.stack([d[:, 1], -d[:, 0]], 1) / np.maximum(L, 1e-9)[:, None]
    return p0, p1, nrm, L, ring_id


def _attach_party_walls(buildings: List[Building]) -> None:
    """For every outline segment: height interval (m above the base, [party_lo, party_h]) of the tallest other
    building directly abutting it. Neighbours that do not overlap the wall's height range (min_height) or
    that overlap this footprint by area (duplicates / stacked parts) are ignored. Pure function of the
    global footprints."""
    if len(buildings) < 2:
        return
    polys = [b.poly for b in buildings]
    tree = shapely.STRtree(polys)
    hs = np.array([b.height_m for b in buildings], float)
    lo = np.array([b.min_height_m for b in buildings], float)
    overlap_cache: dict = {}

    def overlaps(i: int, c: int) -> bool:
        k = (i, c) if i < c else (c, i)
        v = overlap_cache.get(k)
        if v is None:
            try:
                a = polys[i].intersection(polys[c]).area
            except Exception:
                a = 0.0
            v = a > 0.1 * min(polys[i].area, polys[c].area)
            overlap_cache[k] = v
        return v

    for i, b in enumerate(buildings):
        p0, p1, nrm, L, _ = raw_segments(b.poly)
        out = np.zeros(len(L), float)
        outlo = np.full(len(L), np.inf)
        b.party_h, b.party_lo = out, np.zeros(len(L), float)
        if len(L) == 0:
            continue
        mid = (p0 + p1) / 2.0
        pts = shapely.points(mid[:, 0] + nrm[:, 0] * 0.45, mid[:, 1] + nrm[:, 1] * 0.45)
        pts2 = shapely.points(mid[:, 0] + nrm[:, 0] * 0.15, mid[:, 1] + nrm[:, 1] * 0.15)
        for pp in (pts, pts2):
            qi, ti = tree.query(pp, predicate="intersects")
            for a, c in zip(qi, ti):
                a, c = int(a), int(c)
                if c == i or L[a] <= 0.3:
                    continue
                if hs[c] <= b.min_height_m or lo[c] >= b.height_m:  # no height overlap with this wall
                    continue
                if overlaps(i, c):
                    continue
                out[a] = max(out[a], hs[c])
                outlo[a] = min(outlo[a], lo[c])
        b.party_lo = np.where(np.isfinite(outlo), outlo, 0.0)


def _attach_entrances(gdf_utm, cols, buildings: List[Building]) -> None:
    """entrance=* nodes -> the nearest building outline within 2 m (door positions for facade details)."""
    if "entrance" not in cols or not buildings:
        return
    pts = []
    for _, row in gdf_utm.iterrows():
        g = row.geometry
        if g is None or g.geom_type != "Point":
            continue
        v = _tag(row, "entrance")
        if v and v != "no":
            pts.append(g)
    if not pts:
        return
    tree = shapely.STRtree([b.poly for b in buildings])
    for pt in pts:
        best, bd = None, 2.0
        for j in tree.query(pt.buffer(2.0)):
            d = buildings[int(j)].poly.exterior.distance(pt)
            if d < bd:
                best, bd = int(j), d
        if best is not None:
            buildings[best].entrances.append((float(pt.x), float(pt.y)))


def resolve_height_and_roof(key: str, poly: Polygon, h_tag: Optional[float], lv: Optional[float], mh: float,
                            rt: dict, btype: Optional[str], mpf: float, fallback_h: float, cfg: Config):
    """Total building height (to the roof top), min height, and RoofSpec.
    OSM convention: `height` includes the roof; `building:levels` does not."""
    includes_roof = True
    max_h = cfg.max_building_height_m
    if h_tag is not None and h_tag > 0:
        total = min(h_tag, max_h)
    elif lv is not None and lv > 0:
        total = min(lv, cfg.max_building_levels) * mpf
        total = min(total, max_h)
        includes_roof = False
    else:
        total = min(fallback_h, max_h)
    mh = min(mh, max_h)
    if mh >= total:
        mh = 0.0
    shape = roofs.normalize_shape(rt.get("shape"))
    if shape is None:
        shape = roofs.infer_shape(key, btype, poly.area, total, cfg, 2.0 * roofs.frame_of(poly)[5])
    rh_tag, rl_tag = rt.get("height"), rt.get("levels")
    avail = total - mh
    if includes_roof:
        cap = min(cfg.roof_max_height_m, cfg.roof_max_frac * avail)
        if rh_tag:
            cap = min(30.0, 0.85 * avail)
    else:
        cap = min(cfg.roof_max_height_m, 30.0) if not rh_tag else 30.0
    spec = roofs.plan_roof(key, poly, shape, rh_tag, rl_tag, rt.get("direction"), rt.get("orientation"),
                           mpf, cap, cfg)
    if not includes_roof:
        total = total + spec.height_m
    return float(total), float(mh), spec


def wall_segments(poly: Polygon, vs: float):
    """Wall segments (p0, p1, outward normals) long enough to matter; exterior ring first, then courtyard
    (interior) rings. Normals point away from the building material. Deterministic per polygon."""
    rings = [np.asarray(poly.exterior.coords)] + [np.asarray(r.coords) for r in poly.interiors]
    p0 = np.concatenate([r[:-1] for r in rings])
    p1 = np.concatenate([r[1:] for r in rings])
    d = p1 - p0
    L = np.hypot(d[:, 0], d[:, 1])
    k = L >= max(0.5 * vs, 0.5)
    p0, p1, d, L = p0[k], p1[k], d[k], L[k]
    nrm = np.stack([d[:, 1], -d[:, 0]], 1) / L[:, None] if len(L) else np.empty((0, 2))
    return p0, p1, nrm


def _voxelize_lattice(b: Building, grid: Grid, ground: np.ndarray, vs: float, base: int, n: int, mh: int) -> None:
    """Open frame for tower:construction=lattice: four legs at the corners of the footprint's minimum rotated
    rectangle (tapering towards the centre for big base footprints that start at the ground) joined by
    horizontal rings. Pure function of the footprint, so tiles agree."""
    cx, cy, ux, uy, hl, hw = roofs.frame_of(b.poly)
    vx, vy = -uy, ux
    inset = 0.92
    corners = np.array([(cx + sa * hl * inset * ux + sb * hw * inset * vx, cy + sa * hl * inset * uy + sb * hw * inset * vy)
                        for sa in (-1, 1) for sb in (-1, 1)])
    w0 = float(np.clip(0.04 * 2.0 * min(hl, hw), 1.0, 6.0))
    minx, miny, maxx, maxy = b.poly.bounds  # keep legs inside the footprint bbox (tile queries use the bbox)
    pad = min(0.5 * w0 + vs, 0.45 * (maxx - minx), 0.45 * (maxy - miny))
    corners[:, 0] = np.clip(corners[:, 0], minx + pad, maxx - pad)
    corners[:, 1] = np.clip(corners[:, 1], miny + pad, maxy - pad)
    taper = b.min_height_m <= 0.0 and b.height_m >= 40.0 and 2.0 * min(hl, hw) >= 20.0
    s_top = 0.07
    y0 = base + mh + 1
    y1 = base + n  # inclusive top
    ys = np.arange(y0, y1 + 1)
    t = (ys - y0) / max(1.0, float(y1 - y0))
    sx0, sy0 = cx, cy  # point the legs converge to
    if taper:
        sc = 1.0 - (1.0 - s_top) * t ** 0.8
        wscale = 1.0 - 0.6 * t
    elif b.lat_ref is not None:  # a leg section of a big tapering lattice: follow the parent's profile
        sx0, sy0, H = b.lat_ref
        th = np.clip((ys - base) * vs / max(H, 1.0), 0.0, 1.0)
        prof = 1.0 - (1.0 - s_top) * th ** 0.8
        sc = prof / max(float(prof[0]), 1e-6)
        wscale = sc
    else:
        sc = np.ones(len(ys))
        wscale = np.ones(len(ys))
    wv = np.maximum(1, np.rint(w0 * wscale / vs)).astype(np.int64)
    X, Y, Z = [], [], []

    def add(e, nn, y, w):
        cxi = np.floor((e - grid.e0) / vs).astype(np.int64)
        czi = np.floor((grid.n0 - nn) / vs).astype(np.int64)
        for dx in range(int(w.max())):
            for dz in range(int(w.max())):
                m = (dx < w) & (dz < w)
                X.append((cxi - w // 2 + dx)[m]); Z.append((czi - w // 2 + dz)[m]); Y.append(y[m])

    for c in corners:
        add(sx0 + (c[0] - sx0) * sc, sy0 + (c[1] - sy0) * sc, ys, wv)
    if taper:  # horizontal rings between the legs of the big tapered frame
        for f in (0.2, 0.4, 0.6, 0.8):
            k = int(round(f * (len(ys) - 1)))
            s_ = sc[k]
            ring = [sx0 + (corners[i][0] - sx0) * s_ for i in range(4)], [sy0 + (corners[i][1] - sy0) * s_ for i in range(4)]
            order = [0, 1, 3, 2, 0]
            for a, bb in zip(order[:-1], order[1:]):
                L = np.hypot(ring[0][bb] - ring[0][a], ring[1][bb] - ring[1][a])
                m = max(2, int(L / (vs * 0.5)))
                tt = np.linspace(0.0, 1.0, m)
                e = ring[0][a] + (ring[0][bb] - ring[0][a]) * tt
                nn = ring[1][a] + (ring[1][bb] - ring[1][a]) * tt
                add(e, nn, np.full(m, ys[k]), np.full(m, 1, np.int64))
    x = np.concatenate(X); y = np.concatenate(Y); z = np.concatenate(Z)
    key = (x * 4_000_037 + z) * 1_000_003 + y  # unique voxels
    _, first = np.unique(key, return_index=True)
    b.wx, b.wy, b.wz = x[first].astype(np.int32), y[first].astype(np.int32), z[first].astype(np.int32)
    b.rx = b.ry = b.rz = np.empty(0, np.int32)
    b.rk = np.empty(0, np.int8)
    b.eave_y, b.rmax_v, b.open_structure = int(y1), 0, True


def voxelize_building(b: Building, grid: Grid, terrain: Optional[Terrain], cfg: Config,
                      max_vox: Optional[int] = None) -> None:
    """Fill b.w* (walls incl. gable ends / foundations) and b.r* (roof surface) arrays for the WHOLE building
    (global grid indices), and b.owner = (iz, ix) of its first footprint cell (row-major) so exactly one tile
    can count it. Interior stays empty; roof cells are filled down to the lowest neighbouring roof cell so the
    surface is gap-free; perimeter columns are walled up to the roof surface."""
    ix, iz = cells_in_geom(b.poly, grid)
    if len(ix) == 0:
        # tiny footprint: take the cell containing its representative point
        pt = b.poly.representative_point()
        cx = int((pt.x - grid.e0) // grid.vs)
        cz = int((grid.n0 - pt.y) // grid.vs)
        if not (0 <= cx < grid.nx and 0 <= cz < grid.nz):
            return
        ix = np.array([cx], np.int32)
        iz = np.array([cz], np.int32)
    vs = grid.vs
    o = int(np.lexsort((ix, iz))[0])
    b.owner = (int(iz[o]), int(ix[o]))
    ground = ground_points(terrain, grid, iz, ix)
    base = int(ground.min())
    b.base_y = base
    n = max(cfg.min_building_voxels, int(round(b.height_m / vs)))
    mh = int(round(b.min_height_m / vs))
    if b.lattice and b.height_m - b.min_height_m > 8.0:  # lattice / open tower: tapered legs + rings, no walls
        _voxelize_lattice(b, grid, ground, vs, base, n, mh)
        return
    # roof height above the eave per cell, in voxels
    rh = roofs.roof_heights(b.roof, b.poly, grid.centers_e(ix), grid.centers_n(iz))
    r = np.minimum(np.rint(rh / vs).astype(np.int64), max(0, n - mh - 2))
    rmax = int(r.max()) if len(r) else 0
    eave = max(base + n - rmax, int(ground.max()) + 2)  # first roof layer y for r == 0
    b.eave_y, b.rmax_v = int(eave), rmax
    b.open_structure = (b.btype or "") in OPEN_TYPES
    # local masks
    x0, z0 = int(ix.min()), int(iz.min())
    w = int(ix.max()) - x0 + 3
    h = int(iz.max()) - z0 + 3
    m = np.zeros((h, w), bool)
    m[iz - z0 + 1, ix - x0 + 1] = True
    inner = m[1:-1, 1:-1] & m[:-2, 1:-1] & m[2:, 1:-1] & m[1:-1, :-2] & m[1:-1, 2:]
    is_wall = ~inner[iz - z0, ix - x0]
    # roof surface: fill each interior column down to its lowest 4-neighbour (perimeter columns: top only)
    BIG = 1 << 40
    R = np.full((h, w), BIG, np.int64)
    R[iz - z0 + 1, ix - x0 + 1] = r
    nbmin = np.minimum(np.minimum(R[:-2, 1:-1], R[2:, 1:-1]), np.minimum(R[1:-1, :-2], R[1:-1, 2:]))
    rlow = np.minimum(r, nbmin[iz - z0, ix - x0])
    rlow = np.where(is_wall, r, rlow)
    rc = r - rlow + 1
    tot_r = int(rc.sum())
    if max_vox is not None and tot_r > max_vox:
        raise PipelineError("VOXEL_LIMIT", f"Voxel count exceeds maxVoxels ({max_vox}); "
                            "reduce the area or increase voxelSize")
    rep = np.repeat(np.arange(len(r)), rc)
    st = np.cumsum(rc) - rc
    off = np.arange(tot_r) - np.repeat(st, rc)
    b.rx = ix[rep].astype(np.int32)
    b.rz = iz[rep].astype(np.int32)
    b.ry = (eave + rlow[rep] + off).astype(np.int32)
    b.rk = np.zeros(len(b.rx), np.int8)
    # walls (open structures: pillars at the corners and every ~4 m, nothing between)
    keep = is_wall
    if b.open_structure:
        keep = np.zeros(len(ix), bool)
        wi = np.flatnonzero(is_wall)
        if len(wi):
            ring = b.poly.exterior
            Lr = float(ring.length)
            npil = max(2, int(round(Lr / 4.0)))
            spots = [ring.interpolate(Lr * j / npil) for j in range(npil)]
            co = np.asarray(ring.coords)[:-1]
            d1, d2 = np.roll(co, -1, 0) - co, co - np.roll(co, 1, 0)
            cosang = (d1 * d2).sum(1) / np.maximum(np.hypot(*d1.T) * np.hypot(*d2.T), 1e-9)
            sp = np.array([(q.x, q.y) for q in spots] + [tuple(c) for c in co[cosang < 0.85]])
            ce, cn = grid.centers_e(ix[wi]), grid.centers_n(iz[wi])
            for e_, n_ in sp:
                keep[wi[int(np.argmin((ce - e_) ** 2 + (cn - n_) ** 2))]] = True
    wxi, wzi = ix[keep], iz[keep]
    gw = ground[keep].astype(np.int64)
    if mh:
        lower = np.maximum(gw + 1, base + mh + 1)
    else:
        lower = gw + 1
        if terrain is not None and len(wxi):  # foundations: reach the lowest neighbouring ground
            nbg = gw.copy()
            for dz in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dz or dx:
                        nbg = np.minimum(nbg, terrain.points(grid, wzi + dz, wxi + dx).astype(np.int64))
            deep = max(1, int(round(cfg.foundation_max_m / vs)))
            lower = np.maximum(nbg, gw - deep) + 1
    top_w = eave + r[keep]
    counts = np.maximum(top_w - lower, 0)  # walls occupy lower..top-1
    total = int(counts.sum())
    if max_vox is not None and total + tot_r > max_vox:
        raise PipelineError("VOXEL_LIMIT", f"Voxel count exceeds maxVoxels ({max_vox}); "
                            "reduce the area or increase voxelSize")
    if total:
        rep = np.repeat(np.arange(len(wxi)), counts)
        starts = np.cumsum(counts) - counts
        off = np.arange(total) - np.repeat(starts, counts)
        b.wx = wxi[rep].astype(np.int32)
        b.wz = wzi[rep].astype(np.int32)
        b.wy = (lower[rep] + off).astype(np.int32)
    roofdetail.add_extras(b, cfg, vs, ix, iz, r, int(eave), m, x0, z0, is_wall,
                          grid.centers_e(ix), grid.centers_n(iz))
