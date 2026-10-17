"""Tiled voxelization: planning, per-tile processing, and a spawn-based process pool.

Scheme (no seams, no duplicates): all tiles share ONE global Grid (origin snapped to the global voxel
lattice); a tile owns the integer cell window ``core = (ix0, iz0, ix1, iz1)``. Ground / land cover is
rasterized per cell centre inside the core only. Every building intersecting the core is voxelized and
textured WHOLE (identical code and inputs in every tile it touches), then clipped to the core columns, so
tile outputs are disjoint column sets and the union equals a single-tile run. A building is counted only
by the tile that owns its first footprint cell.

Workers never write to stdout (fd 1 is redirected to stderr); progress travels over a Queue and only the
parent emits protocol events."""
from __future__ import annotations

import multiprocessing as mp
import os
import queue
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np
import shapely

from .config import Config
from .protocol import Cancelled, PipelineError, log
from .voxel import details, facade, ground, props as propmod, roofdetail
from .voxel.ground import Layer, pack
from .voxel.buildings import Building, voxelize_building
from .voxel.grid import Grid, cells_in_geom
from .voxel.terrain import Terrain

MATS = ["ground", "road", "wall", "roof", "water", "vegetation", "other"]
M = {n: i for i, n in enumerate(MATS)}

Core = Tuple[int, int, int, int]


def plan_tiles(nx: int, nz: int, t_cells: int) -> List[Core]:
    """Tile windows (ix0, iz0, ix1, iz1) abutting exactly on voxel boundaries, x-major order."""
    return [(x, z, min(x + t_cells, nx), min(z + t_cells, nz))
            for x in range(0, nx, t_cells) for z in range(0, nz, t_cells)]


@dataclass
class TileTask:
    idx: int
    total: int
    core: Core
    grid: Grid
    terrain: Optional[Terrain]
    cfg: Config
    layers: list              # [voxel.ground.Layer] in paint order
    buildings: List[Building]
    photo: object             # mapillary.assign.PhotoData or None
    mpf: float
    procedural: bool
    max_vox: int
    props: list = field(default_factory=list)  # voxel.props tuples touching this tile


@dataclass
class TileResult:
    idx: int
    x: np.ndarray
    y: np.ndarray
    z: np.ndarray
    code: np.ndarray          # uint32: ((r<<16|g<<8|b) << 3) | material
    buildings: int
    photos: int


class TileCtl:
    """Cancel check + throttled progress reporting handed to process_tile."""

    def __init__(self, cancelled: Callable[[], bool], report: Callable[[float, str], None],
                 min_gap: float = 0.1) -> None:
        self._cancelled = cancelled
        self._report = report
        self._gap = min_gap
        self._last = 0.0

    def check(self) -> None:
        if self._cancelled():
            raise Cancelled()

    def progress(self, frac: float, text: str, force: bool = False) -> None:
        self.check()
        now = time.monotonic()
        if force or now - self._last >= self._gap:
            self._last = now
            self._report(max(0.0, min(1.0, frac)), text)


def process_tile(t: TileTask, ctl: TileCtl) -> TileResult:
    """Voxelize + texture one tile; returns voxels sorted by (x, z, y) with later layers winning."""
    from .mapillary.assign import apply_photos

    g, cfg, vs = t.grid, t.cfg, t.grid.vs
    ix0, iz0, ix1, iz1 = t.core
    nxt, nzt = ix1 - ix0, iz1 - iz0
    ctl.progress(0.0, "voxelizing ground", force=True)
    gx, gy_, gz, gc = ground.ground_voxels(g, t.terrain, cfg, t.layers, t.core, ctl, t.max_vox)
    parts: List[tuple] = [(gx, gy_, gz, gc)]
    del gx, gy_, gz, gc
    total = len(parts[0][0])
    if total > t.max_vox:
        raise PipelineError("VOXEL_LIMIT", f"Voxel count exceeds maxVoxels ({t.max_vox}); "
                            "reduce the area or increase voxelSize")

    for pr in t.props:  # environment first, so buildings (added later) win overlaps
        ctl.check()
        v = propmod.voxelize_prop(pr, g, t.terrain, t.core)
        if v is not None:
            px, py, pz, prgb, pm = v
            parts.append((px.astype(np.int32), py.astype(np.int32), pz.astype(np.int32), pack(prgb, pm)))
            total += len(px)
    if total > t.max_vox:
        raise PipelineError("VOXEL_LIMIT", f"Voxel count exceeds maxVoxels ({t.max_vox}); "
                            "reduce the area or increase voxelSize")

    nb = len(t.buildings)
    owned = photos = 0
    window = cfg.window_color
    for i, b in enumerate(t.buildings):
        ctl.progress(0.2 + 0.8 * i / max(1, nb), f"voxelizing buildings {i}/{nb}")
        voxelize_building(b, g, t.terrain, cfg, t.max_vox)
        if b.count == 0:
            continue
        seed = facade.seed_for(b.key, cfg.seed)  # per building id, never per tile
        wc, rc = facade.building_colours(seed, b.kind, b.wall_tag, b.roof_tag, b.roof.shape,
                                       b.wall_mat, b.roof_mat)
        if t.procedural:
            b.roof_rgb = rc
            if vs <= roofdetail.DETAIL_MAX_VS and cfg.roof_details and len(b.rx):
                b.roof_rgb_arr = roofdetail.roof_colours(b, rc, wc, vs, seed)
            if vs <= details.DETAIL_MAX_VS and cfg.facade_details:
                b.facade_texture = cfg.facade_texture
                details.apply_details(b, g, vs, t.mpf, wc, window, seed)
            else:
                b.wall_rgb = facade.wall_colours(b.wx, b.wy, b.wz, b.base_y, vs, t.mpf, wc, window,
                                                 windows=b.wall_mat != "glass" and not b.open_structure)
        else:
            b.roof_rgb = (140, 140, 140)
            b.wall_rgb = np.tile(np.array([200, 200, 200], np.uint8), (len(b.wx), 1))
        if t.photo is not None:
            try:
                apply_photos(b, g, vs, cfg, t.photo)
            except Exception as e:  # photo texturing must never fail the run: keep procedural colours
                log(f"photo sampling failed for {b.key}: {type(e).__name__}: {e}")
                b.photo = False
        if b.owner is not None and ix0 <= b.owner[1] < ix1 and iz0 <= b.owner[0] < iz1:
            owned += 1
            photos += 1 if b.photo else 0
        mw = (b.wx >= ix0) & (b.wx < ix1) & (b.wz >= iz0) & (b.wz < iz1)
        mr = (b.rx >= ix0) & (b.rx < ix1) & (b.rz >= iz0) & (b.rz < iz1)
        nw, nr = int(mw.sum()), int(mr.sum())
        if nw:
            parts.append((b.wx[mw], b.wy[mw], b.wz[mw], pack(b.wall_rgb[mw], M["wall"])))
        if nr:
            rcol = (b.roof_rgb_arr[mr] if b.roof_rgb_arr is not None
                    else np.tile(np.array(b.roof_rgb, np.uint8), (nr, 1)))
            parts.append((b.rx[mr], b.ry[mr], b.rz[mr], pack(rcol, M["roof"])))
        total += nw + nr
        if total > t.max_vox:
            raise PipelineError("VOXEL_LIMIT", f"Voxel count exceeds maxVoxels ({t.max_vox}); "
                                "reduce the area or increase voxelSize")
        # free per-building arrays
        b.wx = b.wy = b.wz = b.rx = b.ry = b.rz = np.empty(0, np.int32)
        b.wall_rgb = None
        b.roof_rgb_arr = b.rk = None

    ctl.progress(0.97, "merging", force=True)
    X = np.concatenate([p[0] for p in parts])
    Y = np.concatenate([p[1] for p in parts])
    Z = np.concatenate([p[2] for p in parts])
    C = np.concatenate([p[3] for p in parts])
    parts.clear()
    ymin = int(Y.min())
    ymax = int(Y.max()) - ymin + 2
    key = ((X.astype(np.int64) - ix0) * nzt + (Z.astype(np.int64) - iz0)) * ymax + (Y.astype(np.int64) - ymin)
    order = np.argsort(key, kind="stable")
    ks = key[order]
    last = np.ones(len(ks), bool)
    last[:-1] = ks[1:] != ks[:-1]  # later layers win
    order = order[last]
    return TileResult(t.idx, X[order], Y[order], Z[order], C[order], owned, photos)


# ───────────────────────────── process pool ─────────────────────────────

def _watch_parent(ppid: int) -> None:
    while True:
        time.sleep(1.0)
        if os.getppid() != ppid:
            os._exit(1)


def _worker_main(task_q, result_q, cancel_ev, ppid: int) -> None:
    """Entry point of a spawned worker. Importable at module level (spawn-safe)."""
    try:
        os.dup2(2, 1)  # stdout is the protocol channel: nothing from a worker may reach it
    except OSError:
        pass
    sys.stdout = sys.stderr
    threading.Thread(target=_watch_parent, args=(ppid,), daemon=True).start()
    while True:
        try:
            task = task_q.get(timeout=1.0)
        except queue.Empty:
            continue
        if task is None:
            break
        idx = task.idx
        ctl = TileCtl(cancel_ev.is_set, lambda f, text, idx=idx: result_q.put(("prog", idx, f, text)))
        try:
            result_q.put(("done", idx, process_tile(task, ctl)))
        except Cancelled:
            result_q.put(("cancelled", idx))
        except PipelineError as e:
            result_q.put(("err", idx, e.code, e.message))
        except BaseException as e:  # noqa: BLE001
            log(traceback.format_exc())
            result_q.put(("err", idx, "INTERNAL", f"{type(e).__name__}: {e}"))
        del task


class TilePool:
    """N spawned worker processes fed through a task queue; results/progress come back on one queue."""

    def __init__(self, n: int) -> None:
        os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
        ctx = mp.get_context("spawn")
        self.task_q = ctx.Queue()
        self.result_q = ctx.Queue()
        self.cancel = ctx.Event()
        self.procs = [ctx.Process(target=_worker_main, name=f"vw-tile-{i}", daemon=True,
                                  args=(self.task_q, self.result_q, self.cancel, os.getpid()))
                      for i in range(n)]
        for p in self.procs:
            p.start()
        self.size = n

    def submit(self, task: TileTask) -> None:
        self.task_q.put(task)

    def get(self, timeout: float):
        try:
            return self.result_q.get(timeout=timeout)
        except queue.Empty:
            return None

    def dead(self) -> Optional[int]:
        for p in self.procs:
            if not p.is_alive():
                return p.exitcode
        return None

    def close(self, kill: bool) -> None:
        """Stop all workers. kill=True: terminate immediately (cancel/error paths)."""
        self.cancel.set()
        if kill:
            for p in self.procs:
                if p.is_alive():
                    p.terminate()
        else:
            for _ in self.procs:
                try:
                    self.task_q.put(None)
                except Exception:
                    pass
        deadline = time.monotonic() + (0.4 if kill else 5.0)
        for p in self.procs:
            p.join(max(0.0, deadline - time.monotonic()))
        for p in self.procs:
            if p.is_alive():
                p.kill()
                p.join(1.0)
        for q in (self.task_q, self.result_q):
            try:
                q.cancel_join_thread()
                q.close()
            except Exception:
                pass


class Merged:
    def __init__(self) -> None:
        self.x: List[np.ndarray] = []
        self.y: List[np.ndarray] = []
        self.z: List[np.ndarray] = []
        self.c: List[np.ndarray] = []
        self.total = 0
        self.buildings = 0
        self.photos = 0

    def add(self, r: TileResult) -> None:
        self.x.append(r.x); self.y.append(r.y); self.z.append(r.z); self.c.append(r.code)
        self.total += len(r.x)
        self.buildings += r.buildings
        self.photos += r.photos


def run_tiles(job, prog, n_tiles: int, make_task: Callable[[int], TileTask], pool: Optional[TilePool],
              max_vox: int) -> Merged:
    """Process all tiles (inline when pool is None) and merge results as they arrive.

    ``prog(frac, message, done)`` reports overall tile-phase progress. Enforces maxVoxels globally and
    honours cancel between and inside tiles (pool is killed by the caller's finally/close)."""
    merged = Merged()
    partial: Dict[int, float] = {}
    done = 0
    t0 = time.monotonic()
    last_emit = [0.0]
    last_msg = ["starting"]

    def report(idx: int, frac: float, text: str, force: bool = False) -> None:
        partial[idx] = frac
        last_msg[0] = f"Tile {idx + 1} of {n_tiles} — {text}"
        now = time.monotonic()
        if force or now - last_emit[0] >= 0.15:
            last_emit[0] = now
            prog((done + sum(partial.values())) / n_tiles, last_msg[0], done)

    def finish(r: TileResult) -> None:
        nonlocal done
        merged.add(r)
        if merged.total > max_vox:
            raise PipelineError("VOXEL_LIMIT", f"Voxel count exceeds maxVoxels ({max_vox}); "
                                "reduce the area or increase voxelSize")
        partial.pop(r.idx, None)
        done += 1
        last_emit[0] = time.monotonic()
        prog(done / n_tiles, f"Tile {r.idx + 1} of {n_tiles} — done", done)

    prog(0.0, f"Tile 1 of {n_tiles} — starting", 0)
    if pool is None:
        for i in range(n_tiles):
            task = make_task(i)
            ctl = TileCtl(job.cancel_event.is_set, lambda f, text, i=i: report(i, f, text))
            ctl.check()
            finish(process_tile(task, ctl))
            del task
        return merged

    next_i = 0
    inflight = 0
    cap = pool.size + 1  # one queued task per worker keeps them busy; bounds memory
    while done < n_tiles:
        job.check()
        while next_i < n_tiles and inflight < cap:
            pool.submit(make_task(next_i))
            next_i += 1
            inflight += 1
            job.check()
        msg = pool.get(0.1)
        if msg is None:
            code = pool.dead()
            if code is not None:
                raise PipelineError("INTERNAL", f"A tile worker process exited unexpectedly (code {code})")
            now = time.monotonic()
            if now - last_emit[0] >= 1.0:  # heartbeat
                last_emit[0] = now
                prog((done + sum(partial.values())) / n_tiles,
                     f"{last_msg[0]} ({int(now - t0)} s)", done)
            continue
        kind = msg[0]
        if kind == "prog":
            report(msg[1], msg[2], msg[3])
        elif kind == "done":
            inflight -= 1
            finish(msg[2])
        elif kind == "err":
            raise PipelineError(msg[2], msg[3])
        elif kind == "cancelled":
            raise Cancelled()
    return merged
