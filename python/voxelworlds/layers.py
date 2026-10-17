"""OSM features -> ground paint layers (land cover, water, paths, roads) in deterministic paint order."""
from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

import shapely
from shapely.ops import substring

from .config import Config
from .osm import fetch as osmfetch
from .protocol import Job
from .voxel.ground import Layer

MAT = {"ground": 0, "road": 1, "water": 4, "vegetation": 5}

_URBAN = {"residential", "commercial", "retail", "industrial", "construction", "railway", "garages",
          "brownfield", "education", "institutional", "quarry"}
_SAND = {"natural=beach", "natural=sand"}
_FOREST = {"natural=wood", "landuse=forest"}
_PITCH = {"leisure=pitch", "leisure=playground"}
_NONVEG = {"natural=bare_rock", "natural=scree", "natural=glacier", "landuse=cemetery"}
_PATH_HW = ("footway", "path", "cycleway", "steps", "pedestrian", "bridleway", "track")
_SKIP_HW = ("proposed", "construction", "corridor", "elevator", "raceway")

# lane markings: dashed centre lines on roads wide enough for two lanes (only at voxel sizes <= MARK_MAX_VS)
MARK_HW = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential"}
MARK_MIN_ROAD_M = 5.5
MARK_MAX_VS = 1.0
MARK_DASH_M, MARK_GAP_M, MARK_END_CLEAR_M = 3.0, 4.5, 2.5
MARK_RGB = (226, 226, 216)


def _rank(key: str) -> int:
    if key.startswith("landuse=") and key[8:] in _URBAN:
        return 0
    if key in _FOREST:
        return 2
    if key in _SAND:
        return 3
    if key in _PITCH or key.startswith("pitch:"):
        return 4
    return 1


def highway_width(row, cfg: Config) -> float:
    w = osmfetch.parse_length_m(osmfetch._tag(row, "width")) if "width" in row.index else None
    if w and 0.5 <= w <= 60:
        return w
    if "lanes" in row.index:
        ln = osmfetch.parse_float(osmfetch._tag(row, "lanes"))
        if ln and 1 <= ln <= 12:
            return ln * cfg.lane_width
    return cfg.road_widths.get(osmfetch._tag(row, "highway") or "", cfg.default_road_width)


def surface_class(value: Optional[str], cfg: Config) -> str:
    """Normalised surface key ('' when absent / unknown)."""
    if not value:
        return ""
    return cfg.surface_aliases.get(value.strip().lower().split(";")[0], "")


# per-surface (jitter %, patch %, checker %)
_SURF_STYLE: Dict[str, Tuple[float, float, float]] = {
    "": (2.5, 0.0, 0.0), "asphalt": (2.5, 1.5, 0.0), "concrete": (2.0, 1.5, 0.0), "paving": (3.0, 0.0, 6.0),
    "gravel": (6.0, 2.0, 0.0), "dirt": (6.0, 3.0, 0.0), "grass": (4.0, 3.0, 0.0), "sand": (4.0, 2.0, 0.0),
    "wood": (3.0, 0.0, 4.0), "unpaved": (5.0, 3.0, 0.0), "metal": (2.0, 0.0, 0.0), "rock": (5.0, 3.0, 0.0),
}


def _split_line(line, piece_m: float):
    n = max(1, int(math.ceil(line.length / piece_m)))
    if n == 1:
        return [line]
    return [substring(line, line.length * i / n, line.length * (i + 1) / n) for i in range(n)]


def lane_markings(src: List[tuple], vs: float) -> list:
    """Dashed centre-line polygons for road ways. Deterministic (input order, fixed dash phase from the way's
    start). Dashes stay clear of way ends (junctions) and are dropped where they touch any other road."""
    if not src:
        return []
    tree = shapely.STRtree([p for _, _, p in src])
    width = max(0.18, 0.9 * vs)
    out: list = []
    for i, (line, rw, rpoly) in enumerate(src):
        L = line.length
        lo, hi = MARK_END_CLEAR_M, L - MARK_END_CLEAR_M
        d = lo
        while d + MARK_DASH_M <= hi:
            seg = substring(line, d, d + MARK_DASH_M)
            d += MARK_DASH_M + MARK_GAP_M
            poly = seg.buffer(width / 2.0, cap_style="flat")
            if poly.is_empty:
                continue
            clash = False
            for j in tree.query(poly):
                if int(j) != i and src[int(j)][2].intersects(poly):
                    clash = True
                    break
            if not clash:
                out.append(poly)
    return out


def build_layers(job: Job, gdf, has_roads: bool, cfg: Config, vs: float) -> List[Layer]:
    """Paint order (later wins): urban landuse, vegetation / natural, forest, sand, pitches, water, paths,
    roads. Within a group layers are ordered by key, so the result is deterministic."""
    cols = set(gdf.columns)
    g = lambda r, k: (osmfetch._tag(r, k) if k in cols else None)
    cover: Dict[str, list] = {}
    water_polys: list = []
    water_quant: list = []
    lines: List[tuple] = []
    roads: Dict[Tuple[int, str], list] = {}
    mark_src: List[tuple] = []   # (centre line, road width m, road polygon) of ordinary road ways
    bridges: Dict[Tuple[int, str], list] = {}
    for n, (_, row) in enumerate(gdf.iterrows()):
        if n % 500 == 0:
            job.check()
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue
        gt = geom.geom_type
        if gt in ("Polygon", "MultiPolygon") and not (g(row, "building") or g(row, "building:part")):
            is_water = (g(row, "natural") in osmfetch.WATER_NATURAL or
                        g(row, "waterway") in ("riverbank", "dock") or
                        g(row, "landuse") in ("reservoir", "basin"))
            keys = []
            for k in ("landuse", "leisure", "natural"):
                v = g(row, k)
                if v and f"{k}={v}" in cfg.landcover_colors:
                    keys.append(f"{k}={v}")
            if is_water or keys:
                polys = osmfetch.polygons_of(geom)
                if is_water:
                    water_polys.extend(polys)
                    water_quant.extend([25.0] * len(polys))
                for key in keys:
                    if key == "leisure=pitch":
                        sc = surface_class(g(row, "surface"), cfg)
                        if sc:
                            key = f"pitch:{sc}"
                    cover.setdefault(key, []).extend(polys)
        ww = g(row, "waterway")
        if ww in osmfetch.WATERWAY_LINES and gt in ("LineString", "MultiLineString"):
            if g(row, "tunnel") in ("yes", "culvert", "building_passage"):
                continue
            w = osmfetch.parse_length_m(g(row, "width"))
            w = w if w and 0.3 <= w <= 300 else cfg.water_widths.get(ww, 2.0)
            lines.append((geom, max(w, vs)))
            continue
        if has_roads:
            hw = g(row, "highway")
            if not hw or hw in _SKIP_HW:
                continue
            if g(row, "tunnel") in ("yes", "building_passage", "culvert"):
                continue
            grp = 0 if hw in _PATH_HW else 1
            sc = surface_class(g(row, "surface"), cfg)
            if cfg.bridges and gt == "LineString" and g(row, "bridge") not in (None, "no") and \
                    geom.length >= 2.0:
                bridges.setdefault((grp, sc), []).append((geom, max(highway_width(row, cfg), vs)))
                continue
            if gt in ("LineString", "MultiLineString"):
                rw = max(highway_width(row, cfg), vs)
                rpoly = geom.buffer(rw / 2.0, cap_style="flat")
                roads.setdefault((grp, sc), []).append(rpoly)
                if gt == "LineString" and hw in MARK_HW and rw >= MARK_MIN_ROAD_M and \
                        g(row, "area") != "yes":
                    mark_src.append((geom, rw, rpoly))
            elif gt in ("Polygon", "MultiPolygon"):
                roads.setdefault((grp, sc), []).extend(osmfetch.polygons_of(geom))

    # waterway centre lines -> buffered pieces (skip lines already inside a water polygon)
    if lines:
        wtree = shapely.STRtree(water_polys) if water_polys else None
        for geom, w in lines:
            job.check()
            parts = list(geom.geoms) if geom.geom_type == "MultiLineString" else [geom]
            for ln in parts:
                if ln.length <= 0:
                    continue
                if wtree is not None:
                    near = wtree.query(ln)
                    if len(near) and ln.intersection(shapely.union_all([water_polys[int(i)] for i in near])
                                                     ).length > 0.8 * ln.length:
                        continue
                for pc in _split_line(ln, cfg.water_piece_m):
                    poly = pc.buffer(w / 2.0, quad_segs=3)
                    if not poly.is_empty:
                        water_polys.append(poly)
                        water_quant.append(5.0)

    layers: List[Layer] = []
    for key in sorted(cover, key=lambda k: (_rank(k), k)):
        if key.startswith("pitch:"):
            rgb = cfg.surface_colors[key[6:]]
            jit, patch, chk = _SURF_STYLE.get(key[6:], (3.0, 0.0, 0.0))
        else:
            rgb = cfg.landcover_colors[key]
            jit, patch, chk = 3.0, cfg.landcover_patch_pct.get(key, 3.0), 0.0
        mat = MAT["ground"] if (_rank(key) in (0, 3, 4) or key in _NONVEG) else MAT["vegetation"]
        layers.append(Layer(rgb, mat, cover[key], jit, patch, chk))
    if water_polys:
        layers.append(Layer(cfg.water_color, MAT["water"], water_polys, 1.5, 0.0, 0.0,
                            levels=[0] * len(water_polys), quant=water_quant))
    for (grp, sc) in sorted(roads, key=lambda k: (k[0], 1 if k[1] in ("", "asphalt") else 0, k[1])):
        if sc:
            rgb = cfg.surface_colors[sc]
        else:
            rgb = cfg.path_color if grp == 0 else cfg.road_color
        jit, patch, chk = _SURF_STYLE.get(sc, (2.5, 0.0, 0.0))
        layers.append(Layer(rgb, MAT["road"], roads[(grp, sc)], jit, patch, chk))
    marks = lane_markings(mark_src, vs) if vs <= MARK_MAX_VS else []
    if marks:
        layers.append(Layer(MARK_RGB, MAT["road"], marks, 0.0, 0.0, 0.0))
    for (grp, sc) in sorted(bridges, key=lambda k: (k[0], 1 if k[1] in ("", "asphalt") else 0, k[1])):
        polys, meta = [], []
        for geom, w in bridges[(grp, sc)]:
            c = list(geom.coords)
            ea, na, eb, nb = c[0][0], c[0][1], c[-1][0], c[-1][1]
            n = max(1, int(math.ceil(geom.length / 8.0)))
            for i in range(n):
                seg = geom if n == 1 else substring(geom, geom.length * i / n, geom.length * (i + 1) / n)
                poly = seg.buffer(w / 2.0, cap_style="flat")
                if not poly.is_empty:
                    polys.append(poly)
                    meta.append((ea, na, eb, nb, (i + 0.5) / n))
        if polys:
            rgb = cfg.surface_colors[sc] if sc else (cfg.path_color if grp == 0 else cfg.road_color)
            jit, patch, chk = _SURF_STYLE.get(sc, (2.5, 0.0, 0.0))
            layers.append(Layer(rgb, MAT["road"], polys, jit, patch, chk, levels=[0] * len(polys),
                                deck=True, meta=meta))
    return layers
