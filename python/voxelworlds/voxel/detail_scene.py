"""'detail' request: re-voxelise ONE building (plus optional neighbour shells) on its own fine local grid.

Reuses the city code paths (extract_buildings -> voxelize_building -> facade.building_colours -> roofdetail ->
details.apply_details) so the building looks like in the city view, only finer. Optionally repaints one wall from
a FacadeSpec (voxel/facade_paint.py) and calls the interior hook (voxel/interior.py::build_interior).

Terrain is flat in the detail scene (ground plate at y = 0 = base_y); the ground height of the original DEM is not
reproduced. Heights use the metersPerFloor / defaultBuildingHeight of the generate run that produced the cache
(stored next to the OSM cache), else 3.5 / 10.5."""
from __future__ import annotations

import math
import os
import time
import uuid
from types import SimpleNamespace
from typing import List, Optional

import numpy as np
import shapely
from shapely.geometry.polygon import orient

from .. import cache
from ..config import DEFAULT_CONFIG, Config
from ..protocol import Cancelled, Job, PipelineError, log
from . import bindex, details, facade, facade_paint, interior, roofdetail
from .buildings import Building, extract_buildings, voxelize_building
from .details import max_protrusion_m
from .grid import Grid, utm_epsg
from .ground import pack
from .merge import merge_unique
from .vwg import write_vwg

DEFAULT_MPF, DEFAULT_H = 3.5, 10.5
MAX_LEVELS = 250
USE_SUBSET = True      # rebuild only the neighbourhood of the building (False = whole-bbox path, same output)
RELEASE_BUILDING_ARRAYS = True   # tests that inspect the Building objects afterwards switch this off
MIN_PART_M2 = 6.0      # building parts smaller than this get no interior of their own
MARGIN_M = 3.0
NEIGHBOUR_MARGIN_M = 12.0


def _validate(p: dict) -> dict:
    try:
        ref = p["ref"]
        bb = {k: float(ref["bbox"][k]) for k in ("latMin", "lonMin", "latMax", "lonMax")}
        bid = ref["buildingId"]
        if not isinstance(bid, str) or not bid:
            raise ValueError("ref.buildingId must be a string")
        if not (-90 <= bb["latMin"] < bb["latMax"] <= 90 and -180 <= bb["lonMin"] < bb["lonMax"] <= 180):
            raise ValueError("bbox out of range or inverted")
        vs = float(p["voxelSize"])
        if not (0.05 <= vs <= 0.5):
            raise ValueError("voxelSize must be within 0.05..0.5")
        max_vox = int(p["maxVoxels"])
        if max_vox <= 0:
            raise ValueError("maxVoxels must be > 0")
        fac = p.get("facade")
        if fac is not None:
            if int(fac["edge"]) != fac["edge"] or int(fac["edge"]) < 0 or not isinstance(fac["spec"], dict):
                raise ValueError("facade needs a non-negative integer edge and a spec object")
            for k in ("wallWidthM", "wallHeightM"):
                if fac["spec"].get(k) is not None:
                    v = float(fac["spec"][k])
                    if not (math.isfinite(v) and 0.5 <= v <= 300.0):
                        raise ValueError(f"facade.spec.{k} must be within 0.5..300 m")
        inter = p.get("interior")
        if inter is not None and not isinstance(inter, dict):
            raise ValueError("interior must be an object")
        if inter is not None and inter.get("enabled"):
            clean = {"enabled": True}
            for k, lo, hi in (("wallThicknessM", 0.02, 5.0), ("roomMinM", 0.5, 50.0)):
                if inter.get(k) is not None:
                    v = float(inter[k])
                    if not math.isfinite(v):
                        raise ValueError(f"interior.{k} must be finite")
                    clean[k] = min(max(v, lo), hi)
            if inter.get("levelsOverride") is not None:
                v = float(inter["levelsOverride"])
                if not math.isfinite(v):
                    raise ValueError("interior.levelsOverride must be finite")
                clean["levelsOverride"] = int(min(max(round(v), 1), MAX_LEVELS))
            if inter.get("seed") is not None:
                v = float(inter["seed"])
                if not math.isfinite(v):
                    raise ValueError("interior.seed must be finite")
                clean["seed"] = int(v)
            inter = clean
    except PipelineError:
        raise
    except Exception as e:
        raise PipelineError("BAD_REQUEST", f"Invalid detail params: {type(e).__name__}: {e}")
    return dict(bbox=bb, bid=bid, vs=vs, max_vox=max_vox, facade=fac,
                interior=inter if inter and inter.get("enabled") else None,
                neighbours=bool(p.get("includeNeighbours")))


def _render(b: Building, grid: Grid, cfg: Config, mpf: float, max_vox: int) -> bool:
    """Voxelise + colour one building volume exactly as tiles.process_tile does (procedural)."""
    vs = grid.vs
    voxelize_building(b, grid, None, cfg, max_vox)
    if b.count == 0:
        return False
    seed = facade.seed_for(b.key, cfg.seed)
    wc, rc = facade.building_colours(seed, b.kind, b.wall_tag, b.roof_tag, b.roof.shape, b.wall_mat, b.roof_mat)
    b.roof_rgb = rc
    if vs <= roofdetail.DETAIL_MAX_VS and cfg.roof_details and len(b.rx):
        b.roof_rgb_arr = roofdetail.roof_colours(b, rc, wc, vs, seed)
    if vs <= details.DETAIL_MAX_VS and cfg.facade_details:
        b.facade_texture = cfg.facade_texture
        details.apply_details(b, grid, vs, mpf, wc, cfg.window_color, seed)
    else:
        b.wall_rgb = facade.wall_colours(b.wx, b.wy, b.wz, b.base_y, vs, mpf, wc, cfg.window_color,
                                         windows=b.wall_mat != "glass" and not b.open_structure)
    return True


def _roof_colours(b: Building) -> np.ndarray:
    n = len(b.rx)
    if b.roof_rgb_arr is not None and len(b.roof_rgb_arr) == n:
        return b.roof_rgb_arr
    return np.tile(np.array(b.roof_rgb, np.uint8), (n, 1))


def _clip(x, y, z, code, grid: Grid):
    m = (x >= 0) & (x < grid.nx) & (z >= 0) & (z < grid.nz)
    if m.all():             # the usual case: no copy
        return x, y, z, code
    return x[m], y[m], z[m], code[m]


# ---- size / memory estimate (measured on real Zurich buildings, 0.1 / 0.15 / 0.25 m; see the module tests)
BYTES_PER_VOXEL = 60          # peak resident bytes per final voxel of run_detail (measured: 57 B/voxel at 34M)
BASE_BYTES = 650e6            # python + numpy + shapely + the OSM table (measured intercept)
MEMORY_LIMIT_BYTES = 3.0e9


def _interior_density(vs: float) -> float:
    """interior voxels per m2 of floor per storey, times vs^2 (slab + partitions + fixtures)"""
    pts = [(0.05, 4.4), (0.06, 3.85), (0.1, 3.5), (0.15, 2.1), (0.25, 1.9), (0.5, 1.5)]
    if vs <= pts[0][0]:
        return pts[0][1]
    for (a, ca), (b, cb) in zip(pts[:-1], pts[1:]):
        if vs <= b:
            return ca + (cb - ca) * (vs - a) / (b - a)
    return pts[-1][1]


def estimate_voxels(grid: Grid, members, others, vs: float, with_interior: bool, mpf: float):
    """(exterior voxels, interior voxels) estimate: plate + 1.16 A + 0.96 sum(P*H) per vs^2 (+/-6 % on 7 real
    buildings), interior adds c(vs) * sum(A * levels) / vs^2."""
    ext = float(grid.nx * grid.nz)
    inner = 0.0
    for b in list(members) + list(others):
        ext += (1.16 * b.poly.area + 0.96 * b.poly.length * max(b.height_m, 1.0)) / (vs * vs)
    if with_interior:
        for b in members:
            lv = max(1, min(int(round(b.height_m / mpf)), MAX_LEVELS))
            inner += _interior_density(vs) * b.poly.area * lv / (vs * vs)
    return int(ext), int(inner)


RELEVANT_COLS = ("building", "building:part", "man_made", "entrance")


def _subset_for_target(gdf, bid: str, vs: float, neighbours: bool, cfg: Config, check):
    """Rows of the (UTM) feature table that determine the voxels of ONE building, so extract_buildings does not
    have to run over the whole bbox on every click. Returns (subset, seed_geometry) or None (use everything).

    Exactness (output identical to the whole-bbox path, verified by tests): extract_buildings looks at other
    features only for (a) building:part <-> parent folding, (b) heights blended from neighbours whose
    representative point lies within cfg.neighbor_radius_m, (c) party walls = height of the buildings that
    touch the outline (whose own heights again use rule b) and (d) entrance nodes on the outline. So the subset is
    closure(features touching the seed) -> + everything within neighbor_radius_m of that closure -> closure.
    The seed is the footprint (or the neighbour window when includeNeighbours)."""
    base = bid.split("#")[0]
    idx = gdf.index
    keys = np.array(["/".join(str(i) for i in (ix if isinstance(ix, tuple) else (ix,))) for ix in idx], dtype=object)
    trow = np.nonzero(keys == base)[0]
    if len(trow) == 0:
        return None
    geoms = np.asarray(gdf.geometry.values, dtype=object)
    rel = np.zeros(len(gdf), bool)
    cols = set(gdf.columns)
    for c in RELEVANT_COLS:
        if c in cols:
            rel |= gdf[c].notna().to_numpy()
    rel_idx = np.nonzero(rel)[0]
    if len(rel_idx) == 0:
        return None
    tree = shapely.STRtree(geoms[rel_idx])

    def hit(g):
        return {int(rel_idx[i]) for i in tree.query(g, predicate="intersects")}

    def close(S, hops):
        for _ in range(hops):
            check()
            S2 = S | hit(shapely.union_all(geoms[sorted(S)]))
            if S2 == S:
                break
            S = S2
        return S
    tg = shapely.union_all(geoms[trow])
    if neighbours:
        x0, y0, x1, y1 = tg.bounds
        m = NEIGHBOUR_MARGIN_M + max_protrusion_m(vs) + 2.0 * vs + 3.0
        seed = shapely.box(x0 - m, y0 - m, x1 + m, y1 + m)
    else:
        seed = tg.buffer(1.0)
    T = close({int(i) for i in trow} | hit(seed), 3)
    check()
    S1 = T | hit(shapely.union_all(geoms[sorted(T)]).buffer(cfg.neighbor_radius_m + 1.0))
    S = close(S1, 2)
    sel = sorted(S | {int(i) for i in trow})
    if len(sel) >= len(gdf):
        return None
    return gdf.iloc[sel], seed


def run_detail(job: Job, p: dict, cfg: Config = DEFAULT_CONFIG) -> None:
    from ..osm import fetch as osmfetch
    from ..pipeline import _palette, out_dir
    from ..tiles import M
    t0 = time.time()
    q = _validate(p)
    bbox, bid, vs, max_vox = q["bbox"], q["bid"], q["vs"], q["max_vox"]

    # ---- OSM (cache hit for the bbox used by generate; a pbf source can also rebuild it from the local file)
    from ..osm import pbf as pbfmod
    src = pbfmod.resolve_source((p.get("ref") or {}).get("dataSource"), missing_code="NO_DATA")
    job.progress("osm", 0, "Loading building data")
    want_roads = osmfetch.cached_roads_variant(bbox, cfg, src) if src else osmfetch.cached_roads_variant(bbox, cfg)
    stale = False
    if not want_roads and not (osmfetch.cached_any(bbox, cfg, src) if src else osmfetch.cached_any(bbox, cfg)):
        if src is not None or not osmfetch.cached_any(bbox, cfg, allow_stale=True):
            # never go to Overpass from a detail request (retry loops of minutes): the generate run's cache is the source
            raise PipelineError("NO_DATA", "OSM cache for this area is missing or expired: generate the scene again")
        # detail (only) may use an expired but present cache of the exact bbox instead of failing
        stale = True
        want_roads = osmfetch.cached_roads_variant(bbox, cfg, allow_stale=True)
        ts = osmfetch.oldest_cached(bbox, cfg)
        day = time.strftime("%Y-%m-%d", time.localtime(ts)) if ts else "an earlier session"
        job.warning("OSM_CACHE_STALE", f"Using saved OSM data from {day} for this world.")
    if src is None:
        kw = {"allow_stale": True} if stale else {}
        gdf = job.run_blocking(lambda: osmfetch.fetch_features(bbox, want_roads, cfg, job.cancel_event, **kw),
                               "Loading building data", poll=0.02)
    else:
        gdf = job.run_blocking(
            lambda: osmfetch.fetch_features(bbox, want_roads, cfg, job.cancel_event, source=src,
                                            on_pbf=lambda f, m: job.progress("pbf", f * 100.0, m)),
            "Loading building data", poll=0.02, unwind=1.0)
    if not len(gdf):
        raise PipelineError("BUILDING_NOT_FOUND", "No OSM data in the bbox")
    clat, clon = (bbox["latMin"] + bbox["latMax"]) / 2.0, (bbox["lonMin"] + bbox["lonMax"]) / 2.0
    epsg, zone, hemi = utm_epsg(clat, clon)
    gdf = gdf[gdf.geometry.notna()].to_crs(epsg)
    job.check()
    meta = cache.get_obj("bparams", "bparams|%.6f,%.6f,%.6f,%.6f" % (bbox["lonMin"], bbox["latMin"],
                                                                  bbox["lonMax"], bbox["latMax"]), 10 * 365 * 86400)
    ref0 = p.get("ref") or {}
    if not meta and not (ref0.get("metersPerFloor") and ref0.get("defaultBuildingHeight")):
        job.warning("DETAIL_PARAMS_DEFAULTED", "The height parameters of the generate run are not saved; using "
                    f"{DEFAULT_MPF} m per floor / {DEFAULT_H} m default height")
    mpf = float(meta["mpf"]) if meta else DEFAULT_MPF
    def_h = float(meta["def_h"]) if meta else DEFAULT_H
    ref_in = p.get("ref") or {}  # explicit values from the host win over the saved ones
    for name in ("metersPerFloor", "defaultBuildingHeight"):
        try:
            v = float(ref_in[name])
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(v) and v > 0:
            if name == "metersPerFloor":
                mpf = v
            else:
                def_h = v
    gdf_full = gdf
    sub = seed = None
    if USE_SUBSET:
        try:
            res_ = _subset_for_target(gdf, bid, vs if not q["neighbours"] else vs, q["neighbours"], cfg, job.check)
            if res_ is not None:
                sub, seed = res_
        except (Cancelled, PipelineError):
            raise
        except Exception as e:      # never fail because of the optimisation: use the whole-bbox path
            log(f"detail: neighbourhood subset failed ({type(e).__name__}: {e}); using the whole bbox")
    for attempt in (0, 1):
        use_sub = sub is not None and attempt == 0
        records: list = []
        buildings = extract_buildings(sub if use_sub else gdf_full, cfg, mpf, def_h, job.check, records)
        rec = next((r for r in records if bindex.element_id(r["key"]) == bid), None)
        members = [b for b in buildings if rec is not None and (b.idx_key or b.key) == rec["key"]]
        if rec is None or not members:
            if use_sub:
                continue
            raise PipelineError("BUILDING_NOT_FOUND", f"Building {bid} not found in the bbox data")
        job.progress("osm", 100, "Building found")

        # ---- local grid
        foot = orient(rec["poly"], 1.0)
        minx, miny, maxx, maxy = foot.bounds
        for b in members:
            x0, y0, x1, y1 = (b.reach or b.poly).bounds
            minx, miny, maxx, maxy = min(minx, x0), min(miny, y0), max(maxx, x1), max(maxy, y1)
        mg = (NEIGHBOUR_MARGIN_M if q["neighbours"] else MARGIN_M) + max_protrusion_m(vs)
        gx0, gx1 = math.floor((minx - mg) / vs), math.ceil((maxx + mg) / vs)
        gy1, gy0 = math.ceil((maxy + mg) / vs), math.floor((miny - mg) / vs)
        grid = Grid(epsg, zone, hemi, gx0 * vs, gy1 * vs, vs, max(1, gx1 - gx0), max(1, gy1 - gy0))
        if grid.nx * grid.nz > max_vox:
            raise PipelineError("VOXEL_LIMIT", f"The ground plate alone needs {grid.nx * grid.nz:,} voxels but "
                                f"maxVoxels is {max_vox:,}; increase the voxel size")
        window = shapely.box(grid.e0, grid.n0 - grid.nz * vs, grid.e0 + grid.nx * vs, grid.n0)
        if use_sub and q["neighbours"] and not seed.contains(window):
            continue        # exotic reach (lattice legs): the subset does not cover the window, use everything
        others: List[Building] = []
        if q["neighbours"]:
            mset = {id(b) for b in members}
            tree = shapely.STRtree([b.poly for b in buildings])
            others = [buildings[int(i)] for i in sorted(tree.query(window)) if id(buildings[int(i)]) not in mset]
        break
    del gdf, gdf_full, sub
    ids = {id(b) for b in members}

    # ---- up-front size / memory estimate: fail fast instead of swapping
    est_ext, est_int = estimate_voxels(grid, members, others, vs, bool(q["interior"]), mpf)
    est_total = est_ext + est_int
    est_bytes = BASE_BYTES + BYTES_PER_VOXEL * est_total
    if est_bytes > MEMORY_LIMIT_BYTES:
        raise PipelineError("VOXEL_LIMIT", f"This detail scene needs about {est_total:,} voxels (estimated "
                            f"~{est_bytes / 1e9:.1f} GB of memory); raise the voxel size"
                            + (" or lower the interior" if q["interior"] else "") + f" (maxVoxels is {max_vox:,})")

    def _limit(extra: str = "") -> PipelineError:
        return PipelineError("VOXEL_LIMIT", f"The detail scene needs about {max(est_total, total + 1):,} voxels but "
                             f"maxVoxels is {max_vox:,}; increase the voxel size or lower the interior{extra}")

    # ---- voxelise (neighbours first, target last so it wins overlaps)
    parts: list = []
    total = grid.nx * grid.nz
    gcode = int(pack(np.array([cfg.urban_ground_color], np.uint8), M["ground"])[0])
    rows_per = max(1, 1_000_000 // grid.nx)
    ax = np.arange(grid.nx, dtype=np.int32)
    for r0 in range(0, grid.nz, rows_per):     # ground plate in strips: cancel stays responsive on big plates
        job.check()
        zz = np.arange(r0, min(grid.nz, r0 + rows_per), dtype=np.int32)
        gx, gz = np.meshgrid(ax, zz)
        parts.append([gx.ravel(), np.zeros(gx.size, np.int32), gz.ravel(), np.full(gx.size, gcode, np.uint32)])
        del gx, gz
    nb = 0
    todo = others + members
    for i, b in enumerate(todo):
        job.progress("init", 100.0 * i / max(1, len(todo)), f"Voxelising {i + 1}/{len(todo)}")
        try:
            # voxelisation / roof & facade detail are plain numpy/shapely calls without cancel hooks: run them on a
            # worker thread so a cancel is honoured within the poll interval
            ok = job.run_blocking(lambda b=b, rem=max_vox - total: _render(b, grid, cfg, mpf, rem),
                                  "Voxelising", poll=0.02)
        except PipelineError as e:
            if e.code == "VOXEL_LIMIT":
                raise _limit()
            raise
        if not ok:
            continue
        nb += 1
        total += b.count
        if total > max_vox:
            raise _limit()
    members = [b for b in members if b.count]
    if not members:
        raise PipelineError("BUILDING_NOT_FOUND", f"Building {bid} produced no voxels at this voxel size")

    # ---- target arrays (+ facade)
    primary = max(members, key=lambda b: (b.poly.area, b.key))
    # levels of the volume actually built (the largest member), not of whichever part is tallest
    h_lv = max(1, int(round(primary.height_m / mpf)))
    lv_rec = rec.get("lv")
    if lv_rec and lv_rec > 0 and lv_rec * mpf <= primary.height_m * 1.25 and primary.height_m <= lv_rec * mpf + 6.0:
        levels = max(1, int(round(lv_rec)))
    else:
        levels = h_lv
    if q["interior"] and q["interior"].get("levelsOverride"):
        levels = max(1, int(q["interior"]["levelsOverride"]))
    levels = max(1, min(levels, MAX_LEVELS, max(1, int(primary.eave_y or 2) - primary.base_y - 1)))
    def _fit(m: Building, lv: int, what: str) -> int:
        """storeys that really fit under the eaves (>= 2.1 m each); the roof volume does not count as height"""
        rows = max(1, int(m.eave_y or 2) - m.base_y - 1)
        fit = max(1, rows // interior.min_storey_rows(vs))
        if lv > fit:
            job.warning("INTERIOR_SIMPLIFIED", f"{what}: only {fit} storey(s) of at least 2.1 m fit under the eaves "
                        f"({rows * vs:.1f} m); {lv} requested, {fit} built")
            return fit
        return lv
    if q["interior"]:
        levels = _fit(primary, levels, "Building")
    tw = np.concatenate([b.wx for b in members]); ty = np.concatenate([b.wy for b in members])
    tz = np.concatenate([b.wz for b in members])
    tc = np.concatenate([b.wall_rgb for b in members]).astype(np.uint8)
    openings: list = []
    n_win = n_door = 0
    wall_t = 1
    fac = q["facade"]
    if fac is not None:
        job.progress("facade", 0, "Painting facade")
        ring_n = len(foot.exterior.coords) - 1
        edge = int(fac["edge"])
        if edge >= ring_n:
            raise PipelineError("BAD_REQUEST", f"facade.edge {edge} out of range (0..{ring_n - 1})")
        co = np.asarray(foot.exterior.coords)
        mid = shapely.Point((co[edge] + co[edge + 1]) / 2.0)
        # the wall belongs to the member nearest to it; levels / floor_ys / interior always use `primary` (largest member)
        fm = min(members, key=lambda b: (round(b.poly.exterior.distance(mid), 3), -b.height_m, b.key))
        res = facade_paint.paint_edge(foot, edge, fac["spec"], grid, fm.base_y, int(fm.eave_y or 0), bid,
                                      check=job.check)
        if res is None:
            job.warning("FACADE_EDGE_UNUSABLE", "That wall is too short or too low to repaint; "
                        "procedural facade kept")
        else:
            nz1 = grid.nz + 1
            rk = res.remove_cells[0].astype(np.int64) * nz1 + res.remove_cells[1].astype(np.int64)
            rm = np.isin(tw.astype(np.int64) * nz1 + tz.astype(np.int64), rk) & (ty < int(fm.eave_y))
            tw, ty, tz, tc = tw[~rm], ty[~rm], tz[~rm], tc[~rm]
            tw = np.concatenate([tw, res.x]); ty = np.concatenate([ty, res.y])
            tz = np.concatenate([tz, res.z]); tc = np.concatenate([tc, res.rgb])
            openings, n_win, n_door, wall_t = res.openings, res.windows, res.doors, res.K
        job.progress("facade", 100, "Facade done")
    job.check()

    for b in others:  # neighbour shells
        if b.count:
            nbx, nby, nbz, nbc = _clip(b.wx, b.wy, b.wz, pack(b.wall_rgb, M["wall"]), grid)
            parts.append([nbx, nby, nbz, nbc])
            rx, ry, rz, rc = _clip(b.rx, b.ry, b.rz, pack(_roof_colours(b), M["roof"]), grid)
            parts.append([rx, ry, rz, rc])
    parts.append([tw, ty, tz, pack(tc, M["wall"])])
    del tw, ty, tz, tc
    for b in members:
        parts.append([b.rx, b.ry, b.rz, pack(_roof_colours(b), M["roof"])])

    # ---- interior hook
    def _detail_for(m: Building, lv: int, wsink: list, budget: int):
        hv_ = (int(m.eave_y or 0) - m.base_y - 1) / float(lv)
        fys = [int(m.base_y + round(k * hv_)) for k in range(lv)]
        m.detail = SimpleNamespace(levels=lv, level_h_vox=hv_, floor_ys=fys, members=members,
                                   openings=openings, wall_t=wall_t, rooms=0, check=job.check,
                                   max_voxels=max(0, budget), user_max_voxels=max_vox, warnings=wsink, doors_added=0)
        return hv_, fys
    hv, floor_ys = _detail_for(primary, levels, [], max_vox - total)
    if q["interior"]:
        job.progress("interior", 0, "Building interior")
        opts = dict(q["interior"])
        # every member (building:part) of the record gets its own interior, largest first: the primary keeps the seed
        # of a single-part building, the others derive theirs from their key
        order = [primary] + sorted((m for m in members if m is not primary and m.poly.area >= MIN_PART_M2),
                                   key=lambda m: (-m.poly.area, m.key))
        used = 0
        rooms_total = 0
        for mi, m in enumerate(order):
            if mi:
                job.progress("interior", 100.0 * mi / len(order), f"Building interior of part {mi + 1}/{len(order)}")
                lv_m = max(1, min(int(round(m.height_m / mpf)), MAX_LEVELS, max(1, int(m.eave_y or 2) - m.base_y - 1)))
                if q["interior"].get("levelsOverride"):
                    lv_m = max(1, min(lv_m, levels))
                lv_m = _fit(m, lv_m, f"Building part {mi + 1}")
                _detail_for(m, lv_m, [], max_vox - total - used)
            rng = np.random.default_rng(facade_paint.spec_seed(bid if not mi else bid + "|" + str(m.key),
                                                               {"seed": opts.get("seed")}))
            try:
                xyz, codes = interior.build_interior(m, opts, grid, rng)
                xyz = np.asarray(xyz, np.int32).reshape(-1, 3)
                codes = np.asarray(codes, np.uint32).reshape(-1)
                if len(xyz) != len(codes):
                    raise ValueError("build_interior returned arrays of different length")
                if len(xyz):
                    ix, iy, iz, ic = _clip(xyz[:, 0], xyz[:, 1], xyz[:, 2], codes, grid)
                    del xyz, codes
                    parts.append([ix, iy, iz, ic])
                    used += len(ix)
                    del ix, iy, iz, ic
            except (Cancelled, PipelineError):
                if mi == 0:
                    raise
                job.warning("INTERIOR_PART_SKIPPED", f"Part {m.key} of the building got no interior (voxel budget)")
                continue
            except Exception as e:
                log(f"interior failed: {type(e).__name__}: {e}")
                job.warning("INTERIOR_FAILED", "Interior generation failed; exterior only" if mi == 0
                            else "The interior of one building part failed; that part is left empty")
            for code, msg in m.detail.warnings:
                job.warning(code, msg if mi == 0 else f"{msg} (building part {mi + 1})")
            rooms_total += int(getattr(m.detail, "rooms", 0) or 0)
            n_door += int(getattr(m.detail, "doors_added", 0) or 0)
        primary.detail.rooms = rooms_total
        lb = getattr(primary.detail, "levels_built", None)
        if lb:      # report the storeys that really got slabs (single-level kinds, missing stairs)
            levels = int(lb)
            floor_ys = [int(v) for v in primary.detail.floor_ys_built]
        job.progress("interior", 100, "Interior done")
    job.check()

    # ---- merge, dedupe (later wins), sort (x, z, y): slice-wise, int32, inputs released as they are consumed
    job.progress("serialize", 0, "Merging voxels")
    for b in (others + members) if RELEASE_BUILDING_ARRAYS else []:   # parts hold what is needed: drop references
        for nm in ("wx", "wy", "wz", "rx", "ry", "rz", "wall_rgb", "roof_rgb_arr"):
            if getattr(b, nm, None) is not None:
                setattr(b, nm, None if nm.endswith("rgb") or nm == "roof_rgb_arr" else np.empty(0, np.int32))
    X, Y, Z, C = merge_unique(parts, grid.nz, job.check)
    if len(X) > max_vox:
        raise _limit()
    c, palette, pmat = _palette(C, cfg.max_palette, job.check)
    stats = {"voxelCount": int(len(X)), "buildingCount": nb, "buildingsWithPhotos": 0,
             "buildingsProcedural": nb, "elapsedMs": int((time.time() - t0) * 1000), "tileCount": 1}
    header = {
        "version": 1, "voxelSize": vs, "voxelCount": int(len(X)),
        "origin": {"utmZone": grid.zone, "hemisphere": grid.hemisphere, "easting": grid.e0,
                   "northing": grid.n0, "elevation": 0.0, "epsg": grid.epsg},
        "bbox": bbox,
        "extent": {"min": [int(X.min()), int(Y.min()), int(Z.min())],
                   "max": [int(X.max()) + 1, int(Y.max()) + 1, int(Z.max()) + 1]},
        "palette": palette, "materials": pmat, "stats": stats,
    }
    path = os.path.join(out_dir(), f"vw-{uuid.uuid4().hex[:12]}.vwg")
    tmp = path + ".part"
    try:
        write_vwg(tmp, header, X, Y, Z, c, job.check)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    job.progress("serialize", 100, "Written")
    dstats = {"voxelCount": int(len(X)), "levels": levels, "rooms": int(getattr(primary.detail, "rooms", 0)),
              "windows": n_win, "doors": n_door, "elapsedMs": int((time.time() - t0) * 1000),
              "floorYs": floor_ys}
    job.result({"kind": "detail", "vwgPath": path, "stats": dstats})
