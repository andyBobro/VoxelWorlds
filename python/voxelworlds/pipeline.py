"""Generate pipeline: OSM -> (DEM) -> (Mapillary) -> tiled/parallel voxelize+texture -> merge -> VWG1."""
from __future__ import annotations

import math
import os
import tempfile
import time
import uuid
from typing import Dict, List, Optional

import numpy as np
import shapely
from shapely.geometry import MultiPolygon, Polygon

from . import __version__, cache
from .config import DEFAULT_CONFIG, Config
from .osm import dem as demmod
from .osm import fetch as osmfetch
from .osm import pbf as pbfmod
from .protocol import Cancelled, Job, PipelineError, log
from .tiles import M, MATS, TilePool, TileTask, plan_tiles, run_tiles
from .voxel import props as props_mod
from .voxel.buildings import extract_buildings
from .voxel.details import max_protrusion_m
from .voxel.grid import INT32_MAX, make_grid
from .voxel.vwg import write_vwg
from .voxel import ground as groundmod
from . import layers as layersmod


def out_dir() -> str:
    d = os.environ.get("VOXEL_TMP_DIR") or os.path.join(tempfile.gettempdir(), "voxelworlds")
    os.makedirs(d, exist_ok=True)
    return d


def _validate(p: dict) -> None:
    try:
        bb = p["bbox"]
        for k in ("latMin", "lonMin", "latMax", "lonMax"):
            float(bb[k])
        if not (-90 <= bb["latMin"] < bb["latMax"] <= 90 and -180 <= bb["lonMin"] < bb["lonMax"] <= 180):
            raise ValueError("bbox out of range or inverted")
        if not (0.05 <= float(p["voxelSize"]) <= 5.0):
            raise ValueError("voxelSize must be within 0.05..5.0")
        if p.get("tileSize") is not None and not (50.0 <= float(p["tileSize"]) <= 5000.0):
            raise ValueError("tileSize must be within 50..5000 metres")
        if p.get("workers") is not None:
            w = float(p["workers"])
            if w != int(w) or not (0 <= w <= 16):
                raise ValueError("workers must be an integer within 0..16")
        if float(p["metersPerFloor"]) <= 0 or float(p["defaultBuildingHeight"]) <= 0:
            raise ValueError("metersPerFloor/defaultBuildingHeight must be > 0")
        if int(p["maxVoxels"]) <= 0:
            raise ValueError("maxVoxels must be > 0")
        p["features"]["roads"]
    except PipelineError:
        raise
    except Exception as e:
        raise PipelineError("BAD_REQUEST", f"Invalid generate params: {e}")


# overall-progress ranges per stage when the run is tiled (pct then means whole-job progress)
_RANGES = {"init": (0, 2), "osm": (2, 15), "pbf": (2, 15), "dem": (15, 20), "mapillary": (20, 30), "project": (30, 30),
           "voxelize": (30, 95), "texture": (30, 95), "serialize": (95, 100)}


class Prog:
    """Progress front-end. Single-tile runs keep per-stage pct; tiled runs emit monotonic OVERALL pct with
    ``tile:{done,total}`` on every event."""

    def __init__(self, job: Job, tiled: bool, total: int) -> None:
        self.job, self.tiled, self.total = job, tiled, total
        self.done = 0
        self.last = 0.0

    def __call__(self, stage: str, pct: float, msg: str = "") -> None:
        if not self.tiled:
            self.job.progress(stage, pct, msg)
            return
        lo, hi = _RANGES.get(stage, (0, 100))
        self.last = max(self.last, lo + (hi - lo) * max(0.0, min(100.0, pct)) / 100.0)
        self.job.progress(stage, self.last, msg, tile={"done": self.done, "total": self.total})

    def tiles(self, frac: float, msg: str, done: int) -> None:
        self.done = done
        self("voxelize", frac * 100.0, msg)

    def sub(self, stage: str, lo: float, hi: float, msg: str):
        def f(frac: float) -> None:
            self(stage, lo + (hi - lo) * frac, msg)
        return f


def _crop(terrain, grid, core, bs, pq):
    """Terrain window for a task: the core plus the bounds of every building / prop it voxelizes whole."""
    if terrain is None:
        return None
    ix0, iz0, ix1, iz1 = core
    vs = grid.vs
    for b in bs:
        x0, y0, x1, y1 = b.poly.bounds
        ix0 = min(ix0, int(math.floor((x0 - grid.e0) / vs)))
        ix1 = max(ix1, int(math.ceil((x1 - grid.e0) / vs)))
        iz0 = min(iz0, int(math.floor((grid.n0 - y1) / vs)))
        iz1 = max(iz1, int(math.ceil((grid.n0 - y0) / vs)))
    for q in pq:
        x0, y0, x1, y1 = props_mod.prop_geom(q).bounds
        ix0 = min(ix0, int(math.floor((x0 - grid.e0) / vs)) - 2)
        ix1 = max(ix1, int(math.ceil((x1 - grid.e0) / vs)) + 2)
        iz0 = min(iz0, int(math.floor((grid.n0 - y1) / vs)) - 2)
        iz1 = max(iz1, int(math.ceil((grid.n0 - y0) / vs)) + 2)
    return terrain.crop(grid, (ix0, iz0, ix1, iz1))


def generate(job: Job, p: dict, cfg: Config = DEFAULT_CONFIG) -> None:
    t0 = time.time()
    _validate(p)
    bbox = {k: float(p["bbox"][k]) for k in ("latMin", "lonMin", "latMax", "lonMax")}
    src = pbfmod.resolve_source(p.get("dataSource"))      # None = Overpass; BAD_REQUEST on a bad pbf source
    if src is not None:
        pbfmod.check_coverage(src, bbox)                  # PBF_UNREADABLE / PBF_NO_COVERAGE before any work
    vs = float(p["voxelSize"])
    feats = p["features"]
    mpf = float(p["metersPerFloor"])
    def_h = float(p["defaultBuildingHeight"])
    max_vox = int(p["maxVoxels"])
    token = (p.get("mapillaryToken") or "").strip()
    tile_m = float(p["tileSize"]) if p.get("tileSize") is not None else cfg.default_tile_size_m
    workers = int(p.get("workers") or 0)

    job.progress("init", 0, "Preparing grid")
    grid, to_utm = make_grid(bbox, vs)
    if grid.nx > INT32_MAX - 2 or grid.nz > INT32_MAX - 2:
        raise PipelineError("BAD_REQUEST", f"Area too large for voxelSize {vs} m: grid {grid.nx}x{grid.nz} "
                            "voxels exceeds the 32-bit index range of the .vwg format; increase voxelSize "
                            "or reduce the area")
    if grid.nx * grid.nz > max_vox:
        raise PipelineError("VOXEL_LIMIT", f"Ground layer alone needs {grid.nx * grid.nz} voxels "
                            f"(limit {max_vox}); reduce the area or increase voxelSize")
    t_cells = max(1, min(cfg.max_tile_cells, int(round(tile_m / vs))))
    cores = plan_tiles(grid.nx, grid.nz, t_cells)
    n_tiles = len(cores)
    if workers <= 0:
        workers = max(1, min(cfg.max_workers_auto, (os.cpu_count() or 2) - 1))
    workers = max(1, min(workers, n_tiles))
    prog = Prog(job, n_tiles > 1, n_tiles)
    prog("init", 100, f"Grid {grid.nx}x{grid.nz} cells, EPSG:{grid.epsg}, {n_tiles} tile(s), "
         f"{workers} worker(s)")

    pool: Optional[TilePool] = None
    try:
        if n_tiles > 1 and workers > 1:
            pool = TilePool(workers)  # warm up while the network stages run
        _generate(job, prog, p, cfg, t0, bbox, vs, feats, mpf, def_h, max_vox, token, grid, to_utm,
                  cores, workers, pool, src)
    finally:
        if pool is not None:
            pool.close(kill=True)  # no-op for workers already stopped; guarantees no orphans


def _generate(job, prog, p, cfg, t0, bbox, vs, feats, mpf, def_h, max_vox, token, grid, to_utm,
              cores, workers, pool, src=None) -> None:
    n_tiles = len(cores)
    # ---- OSM (Overpass, or a local Geofabrik .osm.pbf: stage 'pbf')
    stop = job.cancel_event
    if src is None:
        prog("osm", 0, "Querying Overpass")
        tick_osm = prog.sub("osm", 0, 80, "Querying Overpass")
        gdf = job.run_blocking(
            lambda: osmfetch.fetch_features(bbox, bool(feats.get("roads")), cfg, stop,
                                            lambda d, n: tick_osm(d / n)),
            "Querying Overpass", "this can be slow on first request")
    else:
        prog("pbf", 0, f"Reading region '{src.region_id}'")
        gdf = job.run_blocking(
            lambda: osmfetch.fetch_features(bbox, bool(feats.get("roads")), cfg, stop, source=src,
                                            on_pbf=lambda f, m: prog("pbf", f * 80.0, m)),
            "Reading OSM extract", "the first use of a large region builds a one-time index", unwind=1.0)
    prog("osm", 80, f"Received {len(gdf)} features")
    if len(gdf):
        gdf = gdf[gdf.geometry.notna()]
        gdf = gdf.to_crs(grid.epsg)
    prog("osm", 100, "OSM done")

    bidx_records: list = []
    buildings = extract_buildings(gdf, cfg, mpf, def_h, job.check, bidx_records) if len(gdf) else []
    try:  # remember the height parameters so a later 'detail' request (which only knows the bbox) matches
        cache.put_obj("bparams", "bparams|%.6f,%.6f,%.6f,%.6f" % (bbox["lonMin"], bbox["latMin"], bbox["lonMax"],
                                                               bbox["latMax"]), {"mpf": mpf, "def_h": def_h})
    except Exception:
        pass
    has_roads = bool(feats.get("roads")) and len(gdf) and "highway" in gdf.columns and \
        gdf["highway"].notna().any()
    if not buildings and not has_roads:
        raise PipelineError("NO_DATA", "No buildings or roads found in the selected area")
    layers = layersmod.build_layers(job, gdf, bool(has_roads), cfg, vs) if len(gdf) else []
    env_props: list = []
    if cfg.environment_props and len(gdf) and vs <= cfg.props_max_voxel_size:
        try:
            env_props = props_mod.build_props(gdf, cfg, job.check)
        except Cancelled:
            raise
        except Exception as e:  # environment is decoration: never fail the run
            log(f"props error: {type(e).__name__}: {e}")
    del gdf

    # ---- DEM
    terrain = None
    datum = 0.0
    if feats.get("elevation"):
        prog("dem", 0, "Fetching elevation")
        try:
            tick = prog.sub("dem", 0, 95, "Sampling DEM")
            terrain = job.run_blocking(lambda: demmod.fetch_terrain(grid, cfg, tick, stop, job.warning),
                                       "Fetching elevation")
        except Cancelled:
            raise
        except Exception as e:
            log(f"DEM error: {type(e).__name__}: {e}")
            terrain = None
        if terrain is None:
            job.warning("DEM_UNAVAILABLE", "Elevation service unavailable; using flat ground")
        else:
            datum = terrain.datum
        prog("dem", 100, "Elevation done")

    # ---- Mapillary (global image assignment so facades agree across tile seams)
    photo = None
    if token:
        prog("mapillary", 0, "Searching Mapillary imagery")
        imgs = None
        try:
            from .mapillary import client as mc
            imgs = job.run_blocking(lambda: mc.fetch_images(bbox, token, grid, to_utm, cfg),
                                    "Searching Mapillary imagery")
        except Cancelled:
            raise
        except Exception as e:
            msg = str(e).replace(token, "***")
            job.warning("NO_MAPILLARY_COVERAGE", f"Mapillary unavailable ({type(e).__name__}: {msg[:200]}); "
                        "using procedural facades")
        else:
            if imgs is None:
                job.warning("NO_MAPILLARY_COVERAGE", "No Mapillary imagery in this area; "
                            "using procedural facades")
        prog("mapillary", 50, "Mapillary search done")
        if imgs is not None and len(imgs) and buildings:
            try:
                from .mapillary.assign import assign_photos
                photo = assign_photos(job, buildings, imgs, token, cfg, vs,
                                      lambda lo, hi, m: prog.sub("mapillary", lo, hi, m))
            except Cancelled:
                raise
            except Exception as e:
                log(f"mapillary assignment error: {type(e).__name__}")
                job.warning("NO_MAPILLARY_COVERAGE", "Mapillary texturing failed; using procedural facades")
                photo = None
        prog("mapillary", 100, "Mapillary done")
    for L in layers:
        if L.deck:
            L.levels = groundmod.deck_levels(L, terrain, grid, cfg)
        elif L.levels is not None:  # flat water level per polygon (needs the terrain)
            L.levels = groundmod.water_levels(L, terrain, grid, cfg)
    groundmod.clear_decks_over_water(layers, grid, cfg)
    prog("project", 100, "Projected to UTM")

    # ---- Tiles: voxelize + texture (parallel), merged as they complete
    from .mapillary.assign import PhotoData
    ltrees = [shapely.STRtree(L.polys) for L in layers]
    btree = shapely.STRtree([(b.reach or b.poly) for b in buildings]) if buildings else None
    ptree = shapely.STRtree([props_mod.prop_geom(q) for q in env_props]) if env_props else None
    proc = bool(feats.get("proceduralFacades", True))

    def make_task(i: int) -> TileTask:
        ix0, iz0, ix1, iz1 = cores[i]
        mg = vs + max_protrusion_m(vs)  # buildings carry voxels outside their footprint (balconies)
        box = shapely.box(grid.e0 + ix0 * vs - mg, grid.n0 - iz1 * vs - mg,
                          grid.e0 + ix1 * vs + mg, grid.n0 - iz0 * vs + mg)
        tl = []
        box1 = shapely.box(grid.e0 + ix0 * vs - vs, grid.n0 - iz1 * vs - vs,
                           grid.e0 + ix1 * vs + vs, grid.n0 - iz0 * vs + vs)
        for L, tr in zip(layers, ltrees):  # halo of 1 cell is painted too (skirts need neighbour heights)
            hit = sorted(int(k) for k in tr.query(box1.buffer(vs)))
            if hit:
                tl.append(groundmod.Layer(L.rgb, L.mat, [L.polys[k] for k in hit], L.jit, L.patch, L.checker,
                                          None if L.levels is None else [L.levels[k] for k in hit],
                                          deck=L.deck))
        bs = [buildings[int(k)] for k in sorted(btree.query(box))] if btree is not None else []
        pq = [env_props[int(k)] for k in sorted(ptree.query(box1.buffer(10.0)))] if ptree is not None else []
        ph = None
        if photo is not None:
            need = set()
            for b in bs:
                if b.seg_sel is not None:
                    need.update(int(v) for v in np.unique(b.seg_sel[b.seg_sel >= 0]))
            ph = PhotoData(photo.cam_e, photo.cam_n, photo.cam_h,
                           {k: photo.thumbs[k] for k in need if k in photo.thumbs}, photo.res)
        return TileTask(i, n_tiles, cores[i], grid,
                        _crop(terrain, grid, cores[i], bs, pq), cfg, tl, bs, ph, mpf, proc, max_vox, pq)

    merged = run_tiles(job, prog.tiles, n_tiles, make_task, pool, max_vox)
    if pool is not None:
        pool.close(kill=False)
    with_photo = merged.photos
    nbuild = merged.buildings
    if photo is not None and nbuild and with_photo == 0:
        job.warning("NO_MAPILLARY_COVERAGE", "No Mapillary images matched any building wall")

    # ---- Serialize
    prog("serialize", 0, "Merging voxels")
    X = np.concatenate(merged.x); merged.x.clear()
    Y = np.concatenate(merged.y); merged.y.clear()
    Z = np.concatenate(merged.z); merged.z.clear()
    CODE = np.concatenate(merged.c); merged.c.clear()
    job.check()
    ymin = int(Y.min())
    ymax = int(Y.max()) - ymin + 2
    if grid.nx * (grid.nz + 1) * ymax < 2**62:
        key = (X.astype(np.int64) * (grid.nz + 1) + Z.astype(np.int64)) * ymax + (Y.astype(np.int64) - ymin)
        order = np.argsort(key, kind="stable")  # tiles are internally sorted: long runs
        del key
    else:
        order = np.lexsort((Y, Z, X))
    X, Y, Z, CODE = X[order], Y[order], Z[order], CODE[order]
    del order
    prog("serialize", 40, "Building palette")
    c, palette, pmat = _palette(CODE, cfg.max_palette)
    del CODE
    if len(X) > max_vox:
        raise PipelineError("VOXEL_LIMIT", f"Voxel count exceeds maxVoxels ({max_vox})")
    stats = {"voxelCount": int(len(X)), "buildingCount": nbuild,
             "buildingsWithPhotos": with_photo, "buildingsProcedural": nbuild - with_photo,
             "elapsedMs": int((time.time() - t0) * 1000), "tileCount": n_tiles}
    header = {
        "version": 1, "voxelSize": vs, "voxelCount": int(len(X)),
        "origin": {"utmZone": grid.zone, "hemisphere": grid.hemisphere, "easting": grid.e0,
                   "northing": grid.n0, "elevation": datum, "epsg": grid.epsg},
        "bbox": bbox,
        "extent": {"min": [int(X.min()), int(Y.min()), int(Z.min())],
                   "max": [int(X.max()) + 1, int(Y.max()) + 1, int(Z.max()) + 1]},
        "palette": palette, "materials": pmat, "stats": stats,
    }
    path = os.path.join(out_dir(), f"vw-{uuid.uuid4().hex[:12]}.vwg")
    tmp = path + ".part"
    try:
        write_vwg(tmp, header, X, Y, Z, c)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    try:  # building index sidecar next to the .vwg (vw-xxx.buildings.json); never fails the run
        from .voxel import bindex
        ipath = os.path.splitext(path)[0] + ".buildings.json"
        bindex.write_index(ipath, bindex.build_index(bidx_records, buildings, grid, terrain, mpf))
        stats_out_extra = {"buildingIndexPath": ipath}
    except Exception as e:
        log(f"building index failed: {type(e).__name__}: {e}")
        job.warning("BUILDING_INDEX_FAILED", "Building index could not be written; building picking unavailable")
        stats_out_extra = {}
    prog("serialize", 100, "Written")
    stats.update(stats_out_extra)  # after write_vwg: the .vwg header (and its hash) is unchanged
    stats["elapsedMs"] = int((time.time() - t0) * 1000)
    job.result({"kind": "generate", "vwgPath": path, "stats": stats})


def _apply_ids(code, new_id, inverse, CH, check=None):
    out = np.empty(len(code), np.uint16)
    for i in range(0, len(code), CH):
        if check:
            check()
        out[i:i + CH] = new_id[inverse(code[i:i + CH])]
    return out


def _palette(code: np.ndarray, max_entries: int, check=None):
    """(index per voxel (uint16, 0 reserved), palette rgb list, material names). Exact unique (rgb, material)
    entries when they fit; otherwise a weighted median-cut per material (budget split water-filling style, so
    materials with few colours - ground, roads - stay exact and only the colour-rich ones are merged).
    Works in slices of 4M voxels so the temporaries stay small (identical result to a single np.unique)."""
    from .export.quant import median_cut
    CH = 1_000_000
    ups = []
    for i in range(0, len(code), CH):
        if check:
            check()
        ups.append(np.unique(code[i:i + CH]))
    uniq0 = np.unique(np.concatenate(ups)) if ups else np.empty(0, code.dtype)

    def inverse(chunk):
        return np.searchsorted(uniq0, chunk)
    mat0 = (uniq0 & 7).astype(np.int64)
    rgb0 = (uniq0 >> 3).astype(np.int64)
    rgb_arr = np.stack([(rgb0 >> 16) & 255, (rgb0 >> 8) & 255, rgb0 & 255], 1).astype(np.uint8)
    budget = max_entries - 1
    new_id = np.zeros(len(uniq0), np.int64)
    pal = [[0, 0, 0]]
    pm = ["other"]
    if len(uniq0) <= budget:
        for j in range(len(uniq0)):
            new_id[j] = j + 1
            pm.append(MATS[int(mat0[j])])
            pal.append([int(c) for c in rgb_arr[j]])
        return _apply_ids(code, new_id, inverse, CH, check), pal, pm
    counts = np.zeros(len(uniq0), np.float64)
    for i in range(0, len(code), CH):
        if check:
            check()
        counts += np.bincount(inverse(code[i:i + CH]), minlength=len(uniq0))
    mats = sorted(set(int(m) for m in mat0), key=lambda m: (int((mat0 == m).sum()), m))
    remaining = budget
    alloc = {}
    for i, m in enumerate(mats):
        n_m = int((mat0 == m).sum())
        alloc[m] = min(n_m, max(1, remaining // (len(mats) - i)))
        remaining -= alloc[m]
    for m in sorted(mats):
        idx = np.flatnonzero(mat0 == m)
        cents, mp = median_cut(rgb_arr[idx], counts[idx], alloc[m])
        base = len(pal)
        for c in cents:
            pal.append([int(v) for v in c])
            pm.append(MATS[m])
        new_id[idx] = base + mp
    return _apply_ids(code, new_id, inverse, CH, check), pal, pm
