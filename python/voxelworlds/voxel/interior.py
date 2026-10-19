"""Procedural building interiors for the 'detail' request.

    build_interior(building, opts, grid_spec, rng) -> (xyz int32 (N,3), codes uint32 (N,))

Called by ``voxel/detail_scene.py`` after the exterior of ONE building was voxelised on its own fine grid. The
result is a pure function of (footprint, painted openings, levels, opts, rng seed): no tile dependence.

Inputs (see detail_scene.py): ``building.poly/base_y/eave_y/kind/btype/entrances``; ``building.detail`` with
``levels, floor_ys, openings, wall_t`` and the optional ``check`` (cancel hook, called often), ``max_voxels``
(budget left after the exterior) and ``warnings`` (list of (code, message) the caller emits as warnings).
Outputs written back on ``building.detail``: ``rooms`` (number of rooms, circulation not counted), ``doors_added``
(entrance door painted because the facade had none), ``interior_plan`` (door graph etc. for tests/UI) and
``entrances_raw`` (walking demo: per usable ground-floor door the feet positions inside/outside in metres of the
detail .vwg frame, see ``compute_entrances``; metadata only, no voxel depends on it).

Method
  * Wall depth D = max(wall thickness, painted wall_t) voxels. The free interior is the footprint raster eroded D
    times (same 4-neighbour rule as ``buildings.voxelize_building``), so our walls fit the exterior shell exactly.
  * Everything is planned in metres in the building's principal frame (u along the long side of the minimum
    rotated rectangle, snapped to the grid axes within 4 degrees) with shapely, then rasterised by cell centres.
  * Per storey kind: residential = hall (with the stairs) + optional central corridor + rooms; commercial/civic =
    double-loaded corridor + office strips; shop / generic ground floor = open plan with a counter; industrial =
    one hall with columns; religious = nave with columns, pews and altar. Rooms come from a recursive axis-aligned
    split (cuts snapped to 0.1 m, both sides >= roomMin, no slivers, never through a painted window box).
  * Every room gets one 0.9 x 2.0 m doorway into a room that is already connected (BFS from the entrance room),
    rooms that cannot get a door are merged into a neighbour. Stairs (U or straight, riser <= 0.2 m when the
    voxel size allows) connect all storeys, the slabs above them get a hole; >5 levels also get a lift shaft.
  * Budget: if the estimate exceeds the voxel budget, fixtures, then partitions are dropped (warning
    INTERIOR_SIMPLIFIED); if even slabs + shell do not fit, VOXEL_LIMIT is raised.

Memory: a few (rows x cols) numpy arrays of the footprint bounding box plus the output (~16 bytes/voxel).
Typical cost: 10 x 8 m house at 0.15 m ~ 0.1 s, 60 x 40 m courtyard block with 6 storeys ~ 1-2 s (see tests)."""
from __future__ import annotations

import functools
import math
from types import SimpleNamespace
from typing import Dict, List, Optional, Tuple

import numpy as np
import shapely
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.geometry import box as sbox
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

from ..protocol import PipelineError, log
from .grid import cells_in_geom
from .merge import merge_unique
from ..tiles import M as _M

MW, MO = _M["wall"], _M["other"]

_GEOS_ERR = (shapely.errors.GEOSException, ValueError, ZeroDivisionError)
_RETRY = object()      # _paint_once result: repaint (a repair round widened the doorways)
DISC_CHECK_MAX_CELLS = 400_000   # footprints (cells) above this skip the disc reachability validation


def _guard(default):
    """A failing GEOS call (degenerate geometry) degrades to `default(self, *args)` instead of failing the interior."""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(self, *a, **k):
            try:
                return fn(self, *a, **k)
            except _GEOS_ERR as e:
                log(f"interior: {fn.__name__} skipped ({type(e).__name__}: {e})")
                return default(self, *a, **k)
        return wrapper
    return deco


DOOR_W, DOOR_H = 0.9, 2.0
DOOR_EXTRA_MAX = 0.6   # interior doorways are widened by up to this much (0.2 per repair round) if a 0.6 m disc cannot reach a room
DOOR_APPROACH = 1.2   # m beyond the `outside` point where a painted threshold step in front of a facade door is cleared too
PART_T = 0.1          # partition thickness (m)
SLAB_T = 0.2          # slab thickness (m)
STAIR_W = 1.0         # minimum stair lane width (m); see stair_lane_w()
STAIR_HEAD = 2.5      # vertical clear height above every tread (m): a 1.8 m, 0.6 m deep body on a 45 degree ramp needs 2.4
APRON = 1.5           # open floor in front of / behind stairs (m)
SHOP_TYPES = {"retail", "shop", "supermarket", "mall", "kiosk", "restaurant", "cafe", "bank"}
SINGLE_LEVEL_KINDS = {"religious", "industrial", "minor"}   # tall open volume: ground slab only

C_PLASTER = (236, 232, 222)
C_SLAB = (170, 168, 162)
C_DOOR = (96, 68, 46)
C_STAIR = (168, 140, 104)
C_STAIR_SIDE = (140, 114, 86)

PAL = {
    "wood": [(150, 110, 72), (128, 92, 60), (170, 130, 92)],
    "wood_dark": [(92, 64, 44), (78, 58, 44), (104, 76, 52)],
    "fabric": [(92, 110, 140), (140, 92, 88), (96, 128, 104), (150, 140, 120)],
    "sheet": [(230, 228, 222), (200, 214, 230), (228, 206, 200)],
    "white": [(236, 236, 232)],
    "ceramic": [(240, 242, 244)],
    "counter": [(190, 184, 172), (84, 88, 94), (150, 120, 90)],
    "metal": [(150, 154, 160)],
    "stone": [(196, 190, 178)],
    "crate": [(150, 112, 70), (120, 130, 150)],
}
FLOOR_RGB = {
    "wood": (170, 128, 88), "carpet": (112, 122, 140), "tile": (206, 204, 196), "stone": (188, 182, 170),
    "concrete": (158, 158, 154), "metal": (150, 154, 160),
}
FLOOR_OF = {
    "living": "wood", "dining": "wood", "bedroom": "wood", "study": "wood", "kitchen": "tile", "bath": "tile",
    "wc": "tile", "office": "carpet", "meeting": "carpet", "shop": "tile", "hall": "stone", "corridor": "tile",
    "stairhall": "stone", "stairs": "stone", "industrial": "concrete", "nave": "stone", "lift": "metal",
}


# ───────────────────────────── small geometry helpers ─────────────────────────────

def _polys(g) -> List[Polygon]:
    if g is None or g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return [g]
    if hasattr(g, "geoms"):
        out: List[Polygon] = []
        for s in g.geoms:
            out += _polys(s)
        return out
    return []


def _segments(g) -> List[Tuple[Tuple[float, float], Tuple[float, float]]]:
    """Straight segments of (multi)linestring geometry."""
    out = []
    if g is None or g.is_empty:
        return out
    if g.geom_type == "LineString":
        c = list(g.coords)
        out += [(c[i], c[i + 1]) for i in range(len(c) - 1)]
    elif hasattr(g, "geoms"):
        for s in g.geoms:
            out += _segments(s)
    return out


def _area_key(p: Polygon):
    b = p.bounds
    return (round(b[0], 4), round(b[1], 4), round(p.area, 4))


def _erode(m: np.ndarray) -> np.ndarray:
    p = np.pad(m, 1)
    return p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]


def _empty():
    return np.empty((0, 3), np.int32), np.empty(0, np.uint32)


def _rgb(c) -> np.ndarray:
    return np.asarray(c, np.uint8)


# ───────────────────────────── props (box lists in prop-local metres) ─────────────────────────────
# local frame: x across the prop (0..a), y depth (0 = back, against the wall .. b = front); h0,h1 heights (m)

def _prop(name: str, vs: float, C: Dict[str, tuple]):
    """-> (a, b, [(x0, y0, x1, y1, h0, h1, rgb)]) ; None when it cannot resolve at this voxel size."""
    W = C
    if name == "bed":
        a, b = 1.4, 2.0
        return a, b, [(0, 0, a, b, 0.0, 0.3, W["wood_dark"]), (0.05, 0.1, a - 0.05, b - 0.05, 0.3, 0.5, W["sheet"]),
                      (0.15, 0.15, 0.65, 0.5, 0.5, 0.6, (244, 244, 240)), (0.75, 0.15, 1.25, 0.5, 0.5, 0.6, (244, 244, 240)),
                      (0, 0, a, 0.12, 0.3, 0.95, W["wood_dark"])]
    if name == "wardrobe":
        return 1.2, 0.6, [(0, 0, 1.2, 0.6, 0.0, 2.0, W["wood"])]
    if name == "sofa":
        a, b = 2.0, 0.9
        return a, b, [(0, 0, a, b, 0.0, 0.42, W["fabric"]), (0, 0, a, 0.25, 0.42, 0.9, W["fabric"]),
                      (0, 0, 0.2, b, 0.42, 0.62, W["fabric"]), (a - 0.2, 0, a, b, 0.42, 0.62, W["fabric"])]
    if name == "coffee":
        return 1.0, 0.6, [(0, 0, 1.0, 0.6, 0.0, 0.4, W["wood"])]
    if name == "table":
        a, b = 1.6, 0.9
        if vs < 0.2:
            parts = [(0, 0, a, b, 0.68, 0.76, W["wood"])] + [(x, y, x + 0.1, y + 0.1, 0.0, 0.68, W["wood"])
                                                            for x in (0.02, a - 0.12) for y in (0.02, b - 0.12)]
        else:
            parts = [(0.3, 0.2, a - 0.3, b - 0.2, 0.0, 0.7, W["wood"]), (0, 0, a, b, 0.7, 0.76, W["wood"])]
        return a, b, parts
    if name == "chair":
        return 0.45, 0.45, [(0, 0, 0.45, 0.45, 0.0, 0.45, W["wood"]), (0, 0, 0.45, 0.1, 0.45, 0.9, W["wood"])]
    if name == "counter":
        a, b = 2.6, 0.6
        return a, b, [(0, 0, a, b, 0.0, 1.0, W["counter"]), (0, 0, a, b + 0.1, 1.0, 1.1, W["wood_dark"])]
    if name == "kitchen":
        a, b = 2.4, 0.6
        return a, b, [(0, 0, a, b, 0.0, 0.9, W["counter"]), (0, 0, a, b, 0.9, 0.96, (80, 84, 90)),
                      (0.1, 0.05, 0.7, 0.55, 0.96, 1.0, W["ceramic"])]
    if name == "desk":
        a, b = 1.4, 0.7
        return a, b, [(0, 0, 0.45, b, 0.0, 0.72, W["wood"]), (0, 0, a, b, 0.72, 0.8, W["wood"]),
                      (a - 0.1, 0, a, b, 0.0, 0.72, W["wood"])]
    if name == "wc":
        return 0.4, 0.7, [(0, 0.15, 0.4, 0.7, 0.0, 0.4, W["ceramic"]), (0, 0, 0.4, 0.2, 0.0, 0.85, W["ceramic"])]
    if name == "basin":
        return 0.5, 0.4, [(0.1, 0, 0.4, 0.3, 0.0, 0.7, W["ceramic"]), (0, 0, 0.5, 0.4, 0.7, 0.85, W["ceramic"])]
    if name == "bath":
        return 1.7, 0.75, [(0, 0, 1.7, 0.75, 0.0, 0.55, W["ceramic"])]
    if name == "rack":
        return 1.5, 0.45, [(0, 0, 1.5, 0.45, 0.0, 1.8, W["metal"])]
    if name == "crate":
        return 0.8, 0.8, [(0, 0, 0.8, 0.8, 0.0, 0.8, W["crate"])]
    if name == "pew":
        return 2.4, 0.8, [(0, 0.3, 2.4, 0.8, 0.0, 0.45, W["wood_dark"]), (0, 0.0, 2.4, 0.15, 0.0, 0.95, W["wood_dark"])]
    if name == "altar":
        return 1.8, 0.9, [(0, 0, 1.8, 0.9, 0.0, 1.0, W["stone"]), (-0.0, 0, 1.8, 0.9, 1.0, 1.06, (230, 226, 214))]
    return None


def _orient_parts(parts, a: float, b: float, side: int, ox: float, oy: float):
    """Place prop-local boxes at the wall `side` (0: back at v-min, 1: back at u-max, 2: back at v-max, 3: back at
    u-min) with footprint corner (ox, oy). Returns [(u0, v0, u1, v1, h0, h1, rgb)] and the footprint rect."""
    out = []
    for (x0, y0, x1, y1, h0, h1, c) in parts:
        if side == 0:
            r = (ox + x0, oy + y0, ox + x1, oy + y1)
        elif side == 2:
            r = (ox + a - x1, oy + b - y1, ox + a - x0, oy + b - y0)
        elif side == 3:  # footprint [ox, ox+b] x [oy, oy+a]; local x -> +v, local y -> +u
            r = (ox + y0, oy + x0, ox + y1, oy + x1)
        else:            # side 1: local x -> -v, local y -> -u ; footprint [ox, ox+b] x [oy, oy+a]
            r = (ox + b - y1, oy + a - x1, ox + b - y0, oy + a - x0)
        out.append((r[0], r[1], r[2], r[3], h0, h1, c))
    fp = (ox, oy, ox + a, oy + b) if side in (0, 2) else (ox, oy, ox + b, oy + a)
    return out, fp


# ───────────────────────────── the builder ─────────────────────────────

class _Builder:
    def __init__(self, bd, opts: dict, grid, rng: np.random.Generator):
        self.bd, self.grid, self.rng = bd, grid, rng
        self.det = bd.detail
        self.vs = float(grid.vs)
        vs = self.vs
        self.check = getattr(self.det, "check", None) or (lambda: None)
        self.warnings = getattr(self.det, "warnings", None)
        if self.warnings is None:
            self.warnings = []
            self.det.warnings = self.warnings
        self.max_vox = getattr(self.det, "max_voxels", None)
        try:
            wt = float(opts.get("wallThicknessM") or 0.2)
        except (TypeError, ValueError):
            wt = 0.2
        try:
            rm = float(opts.get("roomMinM") or 2.5)
        except (TypeError, ValueError):
            rm = 2.5
        self.wt = min(max(wt, 0.1), 1.0)
        self.rmin = min(max(rm, 1.2), 15.0)
        self.t_ext = max(1, int(round(self.wt / vs)))
        # painted openings index the WHOLE record ring ("edge"); this builder only knows the member polygon. Map them
        # by position: keep an opening only if it sits on this member's outline (else its door/windows belong to
        # another part of the building and must not steer our entrance or partitions).
        outline = bd.poly.boundary if not bd.poly.is_empty else None
        self.openings = []
        for o in (getattr(self.det, "openings", None) or []):
            if outline is not None:
                E = grid.e0 + 0.5 * (o["x0"] + o["x1"]) * vs
                N = grid.n0 - 0.5 * (o["z0"] + o["z1"]) * vs
                if outline.distance(Point(E, N)) > 0.6 + 2 * max(1, int(getattr(self.det, "wall_t", 1) or 1)) * vs:
                    continue
            self.openings.append(o)
        wall_t = int(getattr(self.det, "wall_t", 1) or 1)
        self.D = max(self.t_ext, wall_t if self.openings else 1, 1)
        self.st = max(1, int(round(SLAB_T / vs)))
        self.door_rows = max(1, int(round(DOOR_H / vs)))
        self.zone_m = max(1, int(math.ceil(0.15 / vs)))
        self.hw_part = 0.5 * PART_T
        self.stair_w = stair_lane_w(vs)
        self.no_fix = False        # repair: no fixtures at all
        self.door_extra = 0.0      # repair: extra interior door width (m), see _unreachable_rooms

    # ---- helpers
    def limit_message(self, interior_voxels: int) -> str:
        """VOXEL_LIMIT text in the user's terms: their maxVoxels and what the whole scene would need."""
        user = getattr(self.det, "user_max_voxels", None)
        ext = (int(user) - int(self.max_vox)) if (user is not None and self.max_vox is not None) else 0
        need = ext + int(interior_voxels)
        return (f"The detail scene needs at least {need:,} voxels but maxVoxels is "
                f"{(int(user) if user is not None else int(self.max_vox or 0)):,}; increase the voxel size or turn "
                "the interior off")

    def uv(self, E, N):
        x, y = np.asarray(E) - self.Ec, np.asarray(N) - self.Nc
        return x * self.cs + y * self.sn, -x * self.sn + y * self.cs

    def world(self, u, v):
        return self.Ec + u * self.cs - v * self.sn, self.Nc + u * self.sn + v * self.cs

    def geom_uv(self, g):
        return shapely.transform(g, lambda a: np.column_stack(self.uv(a[:, 0], a[:, 1])))

    def geom_world(self, g):
        return shapely.transform(g, lambda a: np.column_stack(self.world(a[:, 0], a[:, 1])))

    def cell_E(self, cols):
        return self.grid.e0 + (self.x0 + np.asarray(cols) + 0.5) * self.vs

    def cell_N(self, rows):
        return self.grid.n0 - (self.z0 + np.asarray(rows) + 0.5) * self.vs

    def band(self, p, q, hw: float, ext=None):
        """Cells (rows, cols) whose centre lies within the oriented rectangle around the uv segment p-q."""
        pu, pv = p
        qu, qv = q
        ext = hw if ext is None else ext
        L = math.hypot(qu - pu, qv - pv)
        if L < 1e-9:
            dx, dy = 1.0, 0.0
        else:
            dx, dy = (qu - pu) / L, (qv - pv) / L
        cu = np.array([pu - dx * hw - dy * hw, pu - dx * hw + dy * hw, qu + dx * hw - dy * hw, qu + dx * hw + dy * hw])
        cv = np.array([pv - dy * hw + dx * hw, pv - dy * hw - dx * hw, qv + dy * hw + dx * hw, qv + dy * hw - dx * hw])
        E, N = self.world(cu, cv)
        c0 = int(math.floor((E.min() - self.grid.e0) / self.vs)) - self.x0 - 1
        c1 = int(math.ceil((E.max() - self.grid.e0) / self.vs)) - self.x0 + 1
        r0 = int(math.floor((self.grid.n0 - N.max()) / self.vs)) - self.z0 - 1
        r1 = int(math.ceil((self.grid.n0 - N.min()) / self.vs)) - self.z0 + 1
        c0, r0, c1, r1 = max(0, c0), max(0, r0), min(self.w, c1), min(self.h, r1)
        if c1 <= c0 or r1 <= r0:
            return np.empty(0, np.int64), np.empty(0, np.int64)
        U, V = self.uv(self.cell_E(np.arange(c0, c1))[None, :], self.cell_N(np.arange(r0, r1))[:, None])
        along = (U - pu) * dx + (V - pv) * dy
        across = -(U - pu) * dy + (V - pv) * dx
        m = (along >= -ext) & (along <= L + ext) & (np.abs(across) <= hw)
        rr, cc = np.nonzero(m)
        return rr + r0, cc + c0

    def urect(self, u0, v0, u1, v1):
        """Cells (rows, cols) with centre in the uv rectangle [u0,u1) x [v0,v1)."""
        cu = np.array([u0, u1, u1, u0])
        cv = np.array([v0, v0, v1, v1])
        E, N = self.world(cu, cv)
        c0 = max(0, int(math.floor((E.min() - self.grid.e0) / self.vs)) - self.x0 - 1)
        c1 = min(self.w, int(math.ceil((E.max() - self.grid.e0) / self.vs)) - self.x0 + 1)
        r0 = max(0, int(math.floor((self.grid.n0 - N.max()) / self.vs)) - self.z0 - 1)
        r1 = min(self.h, int(math.ceil((self.grid.n0 - N.min()) / self.vs)) - self.z0 + 1)
        if c1 <= c0 or r1 <= r0:
            return np.empty(0, np.int64), np.empty(0, np.int64)
        U, V = self.uv(self.cell_E(np.arange(c0, c1))[None, :], self.cell_N(np.arange(r0, r1))[:, None])
        m = (U >= u0) & (U < u1) & (V >= v0) & (V < v1)
        rr, cc = np.nonzero(m)
        return rr + r0, cc + c0

    def mask_of(self, rr, cc) -> np.ndarray:
        m = np.zeros((self.h, self.w), bool)
        m[rr, cc] = True
        return m

    # ---- driver
    def run(self):
        bd, det, grid, vs = self.bd, self.det, self.grid, self.vs
        det.rooms = 0
        det.interior_plan = None
        det.entrances_raw = []
        eave, base = bd.eave_y, bd.base_y
        if eave is None or getattr(bd, "lattice", False) or getattr(bd, "open_structure", False) or bd.poly.is_empty:
            return _empty()
        poly = bd.poly
        ix, iz = cells_in_geom(poly, grid, check=self.check)
        if len(ix) == 0:
            return _empty()
        self.x0, self.z0 = int(ix.min()), int(iz.min())
        self.w, self.h = int(ix.max()) - self.x0 + 1, int(iz.max()) - self.z0 + 1
        F = np.zeros((self.h, self.w), bool)
        F[iz - self.z0, ix - self.x0] = True
        self.F = F
        E1 = _erode(F)
        free = F.copy()
        for _ in range(self.D):
            free = _erode(free)
        self.free = free
        self.ring = E1 & ~free          # extra inner wall layers 1..D-1
        if not free.any():
            return _empty()
        self.n_free = int(free.sum())
        self.check()

        kind = getattr(bd, "kind", "generic") or "generic"
        btype = (getattr(bd, "btype", None) or "").lower()
        self.kind, self.btype = kind, btype
        levels = max(1, int(det.levels))
        fy = [int(v) for v in det.floor_ys][:levels]
        n_eff = levels
        if kind in SINGLE_LEVEL_KINDS:
            n_eff = 1
        else:
            min_rows = min_storey_rows(vs)
            if any(fy[i + 1] - fy[i] < min_rows for i in range(len(fy) - 1)):
                if levels > 1:
                    self.warnings.append(("INTERIOR_SIMPLIFIED", "Storeys too low for rooms; only the ground floor "
                                          "interior was generated"))
                n_eff = 1
        self.n_eff = n_eff
        self.fy = fy[:max(1, n_eff)]
        self.top_rows = [self.fy[i + 1] - self.st if i + 1 < n_eff else int(eave) - 1 for i in range(n_eff)]
        if self.top_rows[0] <= self.fy[0] + 1:
            return _empty()

        # frame (u along the long side of the minimum rotated rectangle)
        c = poly.centroid
        self.Ec, self.Nc = round(c.x, 3), round(c.y, 3)
        ang = _principal_angle(poly)
        self.ang = ang
        self.cs, self.sn = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        if abs(self.cs) < 1e-12:
            self.cs = 0.0
        if abs(self.sn) < 1e-12:
            self.sn = 0.0
        self.poly = orient(poly, 1.0)
        self.poly_uv = self.geom_uv(self.poly)

        # simplification level from size and budget
        self.simp = 0
        if self.n_free > 1_500_000:
            self.simp = 1
        if self.n_free > 4_000_000:
            self.simp = 2

        self.setup_zones()
        self.rng_cols()
        self.plan_all()
        return self.paint()

    # ---- colours
    def rng_cols(self):
        self.C = {k: tuple(int(x) for x in v[int(self.rng.integers(len(v)))]) for k, v in sorted(PAL.items())}
        self.floor_shade = float(0.96 + 0.08 * self.rng.random())

    # ---- openings / zones (cell boxes that interior walls and fixtures must keep clear)
    def setup_zones(self):
        self.zones: List[dict] = []   # dict(r0,r1,c0,c1,y0,y1, kind)
        for o in self.openings:
            self.zones.append(dict(r0=o["z0"] - self.z0, r1=o["z1"] - self.z0, c0=o["x0"] - self.x0,
                                   c1=o["x1"] - self.x0, y0=int(o["y0"]), y1=int(o["y1"]), kind=o["kind"],
                                   edge=o.get("edge")))

    def zone_polys_uv(self, lo: int, hi: int, margin: float):
        out = []
        for z in self.zones:
            if z["y0"] <= hi and z["y1"] > lo:
                e0 = self.grid.e0 + (self.x0 + z["c0"]) * self.vs - margin
                e1 = self.grid.e0 + (self.x0 + z["c1"]) * self.vs + margin
                n1 = self.grid.n0 - (self.z0 + z["r0"]) * self.vs + margin
                n0 = self.grid.n0 - (self.z0 + z["r1"]) * self.vs - margin
                E = np.array([e0, e1, e1, e0])
                N = np.array([n0, n0, n1, n1])
                u, v = self.uv(E, N)
                out.append(Polygon(np.column_stack([u, v])).convex_hull)
        return out

    def zone_mask(self, lo: int, hi: int) -> np.ndarray:
        """cells within the margin of painted openings overlapping rows lo..hi (built on demand, never cached:
        a mask per storey would cost one bool array per storey)."""
        m = np.zeros((self.h, self.w), bool)
        for z in self.zones:
            if z["y0"] <= hi and z["y1"] > lo:
                mm = self.zone_m
                m[max(0, z["r0"] - mm):max(0, z["r1"] + mm), max(0, z["c0"] - mm):max(0, z["c1"] + mm)] = True
        return m

    def plan_all(self):
        vs = self.vs
        Dm = self.D * vs
        iu = self.poly_uv.buffer(-Dm, join_style=2, mitre_limit=2.0)
        parts = [p for p in sorted(_polys(iu), key=lambda p: (-p.area, _area_key(p))) if p.area >= 1.0]
        self.parts_plan = []
        if not parts:
            return
        # entrance(s) – one per part
        for i, pu in enumerate(parts):
            self.check()
            try:
                pp = self.plan_part(pu, main=(i == 0))
            except _GEOS_ERR as e:
                log(f"interior: part {i} skipped ({type(e).__name__}: {e})")
                self.warnings.append(("INTERIOR_SIMPLIFIED", "A part of the building could not be planned"))
                pp = None
            if pp is not None:
                self.parts_plan.append(pp)

    # -- entrance
    def find_entrance(self, pu: Polygon, main: bool):
        """-> dict(pt_b (E,N) boundary point, n_in (unit), kind, paint:bool) for this part. Preference: the facade door,
        an OSM entrance node, the longest outline edge touching the part. A painted door must not cover a painted
        window/door box (glass is never overwritten); candidates that would are skipped."""
        P = self.poly
        cands = []
        if main:
            doors = sorted([o for o in self.openings if o["kind"] == "door"],
                           key=lambda o: (o.get("edge", 0), o["x0"], o["z0"]))
            if doors:
                o = doors[0]
                E = self.grid.e0 + 0.5 * (o["x0"] + o["x1"]) * self.vs
                N = self.grid.n0 - 0.5 * (o["z0"] + o["z1"]) * self.vs
                cands.append(("openings", (E, N)))
            for ent in sorted(getattr(self.bd, "entrances", None) or []):
                cands.append(("osm", (float(ent[0]), float(ent[1]))))
        edges = []
        for ri, ring in enumerate([P.exterior] + list(P.interiors)):
            co = np.asarray(ring.coords)
            for k in range(len(co) - 1):
                a, b = co[k], co[k + 1]
                L = float(np.hypot(*(b - a)))
                mid = (a + b) / 2.0
                dist = pu.distance(Point(*self.uv(mid[0], mid[1])))
                if dist > self.D * self.vs + 0.6 or L < 1.2:
                    continue
                edges.append((-round(L, 3), ri, k, tuple(mid)))
        edges.sort()
        cands += [("edge", e[3]) for e in edges]
        if not cands:
            pt = pu.representative_point()
            cands.append(("fallback", self.world(pt.x, pt.y)))
        zmask = self.zone_mask(self.bd.base_y + 1, self.bd.base_y + self.door_rows) if self.zones else None
        first = None
        for kind, p0 in cands:
            ent = self._ent_at(kind, p0)
            first = first or ent
            if not ent["paint"]:
                return ent
            cells = self.door_cells(ent)
            if cells is not None and (zmask is None or not zmask[cells[0], cells[1]].any()):
                return ent
        first["paint"] = False
        self.warnings.append(("INTERIOR_SIMPLIFIED", "No free wall for an entrance door (windows everywhere)"))
        return first

    def _ent_at(self, kind, p0):
        """entrance dict for the outline point nearest to world point p0."""
        P = self.poly
        # nearest outline segment -> inward normal (interior is on the left of the CCW outline)
        bestd, res = 1e18, None
        for ring in [P.exterior] + list(P.interiors):
            co = np.asarray(ring.coords)
            a, b = co[:-1], co[1:]
            d = b - a
            l2 = np.maximum((d * d).sum(1), 1e-12)
            t = np.clip(((p0[0] - a[:, 0]) * d[:, 0] + (p0[1] - a[:, 1]) * d[:, 1]) / l2, 0, 1)
            q = a + d * t[:, None]
            dist = np.hypot(q[:, 0] - p0[0], q[:, 1] - p0[1])
            k = int(np.argmin(dist))
            if dist[k] < bestd:
                bestd = float(dist[k])
                tt = d[k] / math.sqrt(l2[k])
                res = (tuple(q[k]), (-tt[1], tt[0]), tt)
        pt_b, n_in, tan = res
        return dict(kind=kind, pt_b=pt_b, n_in=n_in, tan=tan, paint=(kind not in ("openings",)))

    def inside_point(self, ent, pu: Polygon):
        for off in (self.D * self.vs + 0.6, self.D * self.vs + 0.35, self.D * self.vs + 0.1):
            E = ent["pt_b"][0] + ent["n_in"][0] * off
            N = ent["pt_b"][1] + ent["n_in"][1] * off
            u, v = self.uv(E, N)
            if pu.contains(Point(float(u), float(v))):
                return (float(u), float(v))
        pt = pu.representative_point()
        return (pt.x, pt.y)

    # -- stairs
    @_guard(lambda self,*a,**k: None)
    def place_stairs(self, pu: Polygon, target, pref_axis=None, corridor=None):
        """-> spec dict or None. Footprint boxes are axis aligned in uv. pref_axis: run direction (0 = along u,
        1 = along v) that the caller would like (corridor layouts); other axis costs +4 m."""
        vs = self.vs
        rises = [self.fy[i + 1] - self.fy[i] for i in range(self.n_eff - 1)]
        Rmax = max(rises)
        rise_rows = max(1, int(math.floor(0.2 / vs + 1e-9)))
        n = max(3, int(math.ceil(Rmax / rise_rows)))
        minx, miny, maxx, maxy = pu.bounds
        prep = pu.buffer(-0.05)
        if prep.is_empty:
            return None
        shapely.prepare(prep)
        options = self._stair_options(n)
        if corridor is not None:       # stair body flush against a central corridor strip (v = vc +- cw/2)
            vc, cw = corridor
            for kind, steep, tr, nA, La, Wb, Ltot in options:
                best = None
                for direction in (1, -1):
                    py = vc + cw / 2 - APRON if direction == 1 else vc - cw / 2 - La
                    if py < miny or py + Ltot > maxy:
                        continue
                    xs = np.arange(minx, maxx - Wb + 1e-9, 0.25)
                    if len(xs) == 0:
                        continue
                    c = self._stair_scan(prep, xs, np.array([py]), Wb, Ltot, 1, kind, Ltot, Wb, target, 0.0,
                                         only_dir=direction, La=La)
                    if c is not None and (best is None or c < best):
                        best = c
                if best is not None:
                    score, px, py, direction = best
                    sp = self._stair_spec(kind, steep, tr, nA, La, Wb, Ltot, n, px, py, 1, direction)
                    sp["corr"] = (vc, cw)
                    return sp
        for kind, steep, tr, nA, La, Wb, Ltot in options:
            best = None
            ext = max(maxx - minx, maxy - miny)
            for axis in (0, 1):          # run direction along u (0) or v (1)
                bw, bh = (Ltot, Wb) if axis == 0 else (Wb, Ltot)
                if bw > maxx - minx or bh > maxy - miny:
                    continue
                pen = 0.0 if (pref_axis is None or pref_axis == axis) else 4.0
                step = max(0.25, ext / 70.0)
                xs = np.arange(minx, maxx - bw + 1e-9, step)
                ys = np.arange(miny, maxy - bh + 1e-9, step)
                if len(xs) == 0 or len(ys) == 0:
                    continue
                cands = self._stair_scan(prep, xs, ys, bw, bh, axis, kind, Ltot, Wb, target, pen, La=La)
                if cands is not None and step > 0.25:
                    x0b, y0b = cands[1], cands[2]
                    xs = np.arange(max(minx, x0b - step), min(maxx - bw, x0b + step) + 1e-9, 0.25)
                    ys = np.arange(max(miny, y0b - step), min(maxy - bh, y0b + step) + 1e-9, 0.25)
                    c2 = self._stair_scan(prep, xs, ys, bw, bh, axis, kind, Ltot, Wb, target, pen, La=La)
                    if c2 is not None:
                        cands = c2
                if cands is not None and (best is None or cands[0] < best[0]):
                    best = cands + (axis,)
            if best is not None:
                score, px, py, direction, axis = best
                return self._stair_spec(kind, steep, tr, nA, La, Wb, Ltot, n, px, py, axis, direction)
        return None

    def _stair_scan(self, prep, xs, ys, bw, bh, axis, kind, Ltot, Wb, target, pen=0.0, only_dir=None, La=None):
        X, Y = np.meshgrid(xs, ys)
        X, Y = X.ravel(), Y.ravel()
        boxes = shapely.box(X, Y, X + bw, Y + bh)
        ok = shapely.contains(prep, boxes)
        if not ok.any():
            return None
        X, Y = X[ok], Y[ok]
        best = None
        for direction in ((1, -1) if only_dir is None else (only_dir,)):   # apron at the low / high end of the box
            Xd, Yd = X, Y
            if La is not None:      # the stair body (and a 0.7 m ring) must not cover the entrance point
                off = APRON if (direction == 1 or kind == "S") else 0.0
                if axis == 0:
                    bx0, by0, bx1, by1 = Xd + off, Yd, Xd + off + La, Yd + bh
                else:
                    bx0, by0, bx1, by1 = Xd, Yd + off, Xd + bw, Yd + off + La
                bad = ((target[0] >= bx0 - 0.7) & (target[0] <= bx1 + 0.7) &
                       (target[1] >= by0 - 0.7) & (target[1] <= by1 + 0.7))
                if bad.all():
                    continue
                Xd, Yd = Xd[~bad], Yd[~bad]
            if axis == 0:
                ax = Xd + (APRON / 2 if direction == 1 else bw - APRON / 2)
                ay = Yd + bh / 2
            else:
                ax = Xd + bw / 2
                ay = Yd + (APRON / 2 if direction == 1 else bh - APRON / 2)
            d = np.hypot(ax - target[0], ay - target[1]) + pen
            k = int(np.lexsort((Yd, Xd, np.round(d, 3)))[0])
            cand = (float(d[k]), float(Xd[k]), float(Yd[k]), direction)
            if best is None or cand < best:
                best = cand
        return best

    def _stair_spec(self, kind, steep, tr, nA, La, Wb, Ltot, n, px, py, axis, direction):
        """Local stair frame: a along the ascent, b across; origin at the body start (after the bottom apron)."""
        if axis == 0:
            rect = (px, py, px + Ltot, py + Wb)
            if direction == 1:
                o = (px + APRON, py); ea = (1.0, 0.0); eb = (0.0, 1.0)
            else:
                o = (px + Ltot - APRON, py + Wb); ea = (-1.0, 0.0); eb = (0.0, -1.0)
        else:
            rect = (px, py, px + Wb, py + Ltot)
            if direction == 1:
                o = (px + Wb, py + APRON); ea = (0.0, 1.0); eb = (-1.0, 0.0)
            else:
                o = (px, py + Ltot - APRON); ea = (0.0, -1.0); eb = (1.0, 0.0)

        o = (round(o[0], 2), round(o[1], 2))      # cm grid: boxes derived from it share exact coordinates

        def box_ab(a0, a1, b0, b1):
            pts = [(o[0] + ea[0] * a + eb[0] * b, o[1] + ea[1] * a + eb[1] * b) for a in (a0, a1) for b in (b0, b1)]
            return tuple(round(v, 2) for v in (min(p[0] for p in pts), min(p[1] for p in pts),
                                                 max(p[0] for p in pts), max(p[1] for p in pts)))
        aprons = [box_ab(-APRON, 0.0, 0.0, Wb)]
        if kind == "S":
            aprons.append(box_ab(La, La + APRON, 0.0, Wb))
        return dict(kind=kind, steep=steep, tr=tr, n=n, nA=nA if kind == "U" else n, La=La, Wb=Wb, sw=self.stair_w,
                    rect=rect, o=o, ea=ea, eb=eb, axis=axis, direction=direction, body=box_ab(0.0, La, 0.0, Wb),
                    aprons=aprons)

    def stair_cells(self, sp):
        """body cells of the stair: rows, cols, a, b (local coords)."""
        o, ea, eb = sp["o"], sp["ea"], sp["eb"]
        # body in uv: a in [0, La], b in [0, Wb]
        pts = [(o[0] + ea[0] * a + eb[0] * b, o[1] + ea[1] * a + eb[1] * b)
               for a in (0.0, sp["La"]) for b in (0.0, sp["Wb"])]
        us = [p[0] for p in pts]
        vs_ = [p[1] for p in pts]
        rr, cc = self.urect(min(us), min(vs_), max(us), max(vs_))
        if len(rr) == 0:
            return rr, cc, np.empty(0), np.empty(0)
        E, N = self.cell_E(cc), self.cell_N(rr)
        U, V = self.uv(E, N)
        a = (U - o[0]) * ea[0] + (V - o[1]) * ea[1]
        b = (U - o[0]) * eb[0] + (V - o[1]) * eb[1]
        m = (a >= 0) & (a < sp["La"]) & (b >= 0) & (b < sp["Wb"])
        m &= self.free[rr, cc]
        return rr[m], cc[m], a[m], b[m]

    def spine_cells(self, sp, a, b):
        """(rows, cols) of the wall between the two lanes of a U stair: the cells within a wall thickness of the lane
        boundary b = sw, from the foot (a = 0) to the start of the landing; empty for straight stairs."""
        if sp["kind"] != "U":
            return np.empty(0, np.int64), np.empty(0, np.int64)
        nu, nv = sp["eb"]
        nx = nu * self.cs - nv * self.sn
        nz_ = nu * self.sn + nv * self.cs
        hw = max(self.hw_part, 0.5 * self.vs * (abs(nx) + abs(nz_))) + 1e-6
        m = (np.abs(b - sp["sw"]) <= hw) & (a >= 0) & (a < sp["La"] - sp["sw"])
        rr, cc, _, _ = self.stair_cells(sp)
        return rr[m], cc[m]

    def step_index(self, sp, a, b):
        """step number k (1..n) per cell, 0 = no step."""
        n, tr = sp["n"], sp["tr"]
        if sp["kind"] == "S":
            return np.clip(np.floor(a / tr).astype(np.int64) + 1, 1, n)
        nA, sw = sp["nA"], sp["sw"]
        nB = n - nA
        la = sp["La"] - sw
        trA = la / max(nA - 1, 1)
        trB = la / max(nB, 1)
        k = np.zeros(len(a), np.int64)
        laneA = b < sw
        kA = np.clip(np.floor(a / trA).astype(np.int64) + 1, 1, max(nA - 1, 1))
        kB = nA + np.clip(np.floor((la - a) / trB).astype(np.int64) + 1, 1, max(nB, 1))
        landing = a >= la
        k = np.where(landing, nA, np.where(laneA, kA, kB))
        return k

    # -- lift
    def _corr_parts(self, pu, specs, hall, net, ent_in):
        """circulation pieces (before the entrance route): hall aprons + corridor strips / network / hub."""
        rmin = self.rmin
        spec = specs[0] if specs else None
        minx, miny, maxx, maxy = pu.bounds
        cw = 2.0 if self.kind in ("commercial", "civic") else 1.25
        c_parts = []
        if net is not None:
            c_parts.append(net)
            if hall is not None:
                c_parts.append(hall)
        elif hall is not None:
            c_parts.append(hall)
            if spec.get("corr"):        # central corridor along u, the stair body is flush against it
                vc, cw = spec["corr"]
                c_parts.append(sbox(minx - 1, vc - cw / 2, maxx + 1, vc + cw / 2))
            elif spec["axis"] == 1:     # corridor along u, flush with the stair body edge, covering the apron
                bu0, bv0, bu1, bv1 = spec["body"]
                if spec["direction"] == 1:
                    lo = bv0 - cw
                    if lo - miny < 0.8 * rmin:
                        lo = miny - 1
                    c_parts.append(sbox(minx - 1, lo, maxx + 1, bv0))
                else:
                    hi = bv1 + cw
                    if maxy - hi < 0.8 * rmin:
                        hi = maxy + 1
                    c_parts.append(sbox(minx - 1, bv1, maxx + 1, hi))
        else:
            hub = sbox(ent_in[0] - 1.2, ent_in[1] - 1.2, ent_in[0] + 1.2, ent_in[1] + 1.2).intersection(pu)
            c_parts.append(hub)
            hv = ent_in[1]
            if (maxx - minx) >= 3 * rmin and self._extent_v(pu, hv) >= 2 * rmin + cw:
                c_parts.append(sbox(minx - 1, hv - cw / 2, maxx + 1, hv + cw / 2))
        return c_parts

    @_guard(lambda self, *a, **k: None)
    def place_lift(self, pu, circ, body, avoid):
        """1.6 x 1.6 m lift shaft on the outside of a circulation edge, clear of the stair body (so its door fits)
        and of the entrance; None when nothing fits."""
        S = 1.6
        rest = pu.buffer(-0.05).difference(unary_union([circ, body.buffer(0.6), avoid]))
        if rest.is_empty:
            return None
        shapely.prepare(rest)
        best = None
        for (p, q) in _segments(circ.boundary):
            self.check()
            L = math.hypot(q[0] - p[0], q[1] - p[1])
            if L < S + 0.2:
                continue
            if abs(q[1] - p[1]) < 1e-6:             # horizontal edge: lift above or below it
                x0, x1, e = min(p[0], q[0]), max(p[0], q[0]), p[1]
                for sgn in (1, -1):
                    if circ.contains(Point(0.5 * (x0 + x1), e + 0.05 * sgn)):
                        continue
                    for x in np.arange(x0, x1 - S + 1e-9, 0.4):
                        b = sbox(x, e, x + S, e + S) if sgn == 1 else sbox(x, e - S, x + S, e)
                        if rest.contains(b):
                            d = b.centroid.distance(circ.centroid)
                            key = (round(d, 2), round(x, 2), round(e, 2))
                            if best is None or key < best[0]:
                                best = (key, b)
            elif abs(q[0] - p[0]) < 1e-6:           # vertical edge
                y0, y1, e = min(p[1], q[1]), max(p[1], q[1]), p[0]
                for sgn in (1, -1):
                    if circ.contains(Point(e + 0.05 * sgn, 0.5 * (y0 + y1))):
                        continue
                    for y in np.arange(y0, y1 - S + 1e-9, 0.4):
                        b = sbox(e, y, e + S, y + S) if sgn == 1 else sbox(e - S, y, e, y + S)
                        if rest.contains(b):
                            d = b.centroid.distance(circ.centroid)
                            key = (round(d, 2), round(e, 2), round(y, 2))
                            if best is None or key < best[0]:
                                best = (key, b)
        return best[1] if best else None

    def is_large(self, pu: Polygon) -> bool:
        b = pu.bounds
        return pu.area > 450.0 or min(b[2] - b[0], b[3] - b[1]) > 16.0

    def corridor_width(self) -> float:
        return 2.4 if self.kind in ("commercial", "civic") else 1.8

    @_guard(lambda self,*a,**k: None)
    def _route(self, a, b, pu, cu, w=1.2, avoid=None):
        for first in (0, 1):
            if first == 0:
                legs = [sbox(min(a[0], b[0]) - w / 2, a[1] - w / 2, max(a[0], b[0]) + w / 2, a[1] + w / 2),
                        sbox(b[0] - w / 2, min(a[1], b[1]) - w / 2, b[0] + w / 2, max(a[1], b[1]) + w / 2)]
            else:
                legs = [sbox(a[0] - w / 2, min(a[1], b[1]) - w / 2, a[0] + w / 2, max(a[1], b[1]) + w / 2),
                        sbox(min(a[0], b[0]) - w / 2, b[1] - w / 2, max(a[0], b[0]) + w / 2, b[1] + w / 2)]
            r = unary_union(legs)
            if avoid is not None and not avoid.is_empty and r.intersection(avoid).area > 0.01:
                continue
            ri = r.intersection(pu)
            if ri.area >= 0.97 * r.area:
                return ri
        return None

    @_guard(lambda self, *a, **k: None)
    def _entry_route(self, a, cu, pu, avoid, w=1.2):
        """Walkable strip (width w) from the inside entrance point `a` to the circulation `cu`: shortest path (few
        turns) on a 0.2 m raster of the part, never through `avoid` (stair body, lift) nor closer than w/2 to a
        wall. None when there is no way."""
        import heapq
        minx, miny, maxx, maxy = pu.bounds
        step = max(0.2, math.sqrt(max(1e-6, (maxx - minx) * (maxy - miny)) / 60000.0))
        nx, ny = int(math.ceil((maxx - minx) / step)) + 1, int(math.ceil((maxy - miny) / step)) + 1
        X = minx + (np.arange(nx) + 0.5) * step
        Y = miny + (np.arange(ny) + 0.5) * step
        GX, GY = np.meshgrid(X, Y)
        inner = pu.buffer(-(w / 2 - 0.03), join_style=2, mitre_limit=2.0)
        if inner.is_empty:
            return None
        free = shapely.contains_xy(inner, GX, GY)
        if avoid is not None and not avoid.is_empty:
            free &= ~shapely.contains_xy(avoid.buffer(w / 2 + 0.05), GX, GY)
        goal = shapely.contains_xy(cu.buffer(-0.02), GX, GY) & free
        si, sj = int(np.clip((a[1] - miny) // step, 0, ny - 1)), int(np.clip((a[0] - minx) // step, 0, nx - 1))
        free[si, sj] = True
        if goal[si, sj]:
            return None
        INF = 1 << 30
        best = {}
        heap = [(0, si, sj, -1)]
        best[(si, sj, -1)] = 0
        prev = {}
        end = None
        pops = 0
        while heap:
            c, i, j, d = heapq.heappop(heap)
            if best.get((i, j, d), INF) < c:
                continue
            pops += 1
            if pops % 2000 == 0:
                self.check()
            if goal[i, j]:
                end = (i, j, d)
                break
            for nd, (di, dj) in enumerate(((1, 0), (-1, 0), (0, 1), (0, -1))):
                ni, nj = i + di, j + dj
                if 0 <= ni < ny and 0 <= nj < nx and free[ni, nj]:
                    nc = c + 10 + (0 if (d == nd or d < 0) else 6)
                    if nc < best.get((ni, nj, nd), INF):
                        best[(ni, nj, nd)] = nc
                        prev[(ni, nj, nd)] = (i, j, d)
                        heapq.heappush(heap, (nc, ni, nj, nd))
        if end is None:
            return None
        pts = []
        k = end
        while k is not None:
            pts.append((float(X[k[1]]), float(Y[k[0]])))
            k = prev.get(k)
        pts.reverse()
        line = LineString(pts).simplify(0.001)
        route = line.buffer(w / 2, cap_style=3, join_style=2, mitre_limit=2.0).intersection(pu)
        if avoid is not None and not avoid.is_empty:
            route = route.difference(avoid)
        route = _clean(route)
        return None if route is None or route.is_empty else route

    def _link(self, C, pu, cw):
        """connect the components of corridor geometry C with straight / L shaped strips."""
        from shapely.ops import nearest_points
        for _ in range(12):
            self.check()
            comps = sorted(_polys(C), key=lambda p: (-p.area, _area_key(p)))
            if len(comps) <= 1:
                break
            main = comps[0]
            done = False
            for other in sorted(comps[1:], key=lambda p: (round(p.distance(main), 3), _area_key(p))):
                pa, pb = nearest_points(main, other)
                a, b = (pa.x, pa.y), (pb.x, pb.y)
                route = None
                if abs(a[1] - b[1]) >= abs(a[0] - b[0]):      # mostly across v: straight strip mid-overlap
                    o0 = max(main.bounds[0], other.bounds[0]); o1 = min(main.bounds[2], other.bounds[2])
                    us = [0.5 * (o0 + o1)] if o1 - o0 > 2 * cw else []
                    for u in us + [a[0]]:
                        r = sbox(u - cw / 2, min(a[1], b[1]) - 0.3, u + cw / 2, max(a[1], b[1]) + 0.3)
                        ri = r.intersection(pu)
                        if ri.area >= 0.97 * r.area:
                            route = ri
                            break
                if route is None:
                    route = self._route(a, b, pu, C, cw)
                if route is not None:
                    C = unary_union([C, route])
                    done = True
                    break
            if not done:
                break
        return C

    @_guard(lambda self,*a,**k: None)
    def corridor_net(self, pu: Polygon, ent_in, cw: float):
        """Ring corridors around courtyards + spines along the principal axes until every point of the floor is
        within ~7 m of a corridor (so no room is deeper than ~7 m), all linked into one network."""
        minx, miny, maxx, maxy = pu.bounds
        parts = []
        for hole in pu.interiors:
            H = Polygon(hole)
            if H.area > 30.0:
                parts.append(H.buffer(cw, join_style=2, mitre_limit=2.0).difference(H).intersection(pu))
        C = unary_union(parts) if parts else Polygon()
        for _ in range(14):
            self.check()
            cov = C.buffer(7.0) if not C.is_empty else Polygon()
            U = pu.difference(cov) if not cov.is_empty else pu
            pieces = [q for q in _polys(U) if q.area >= 30.0]
            if not pieces:
                break
            q = max(pieces, key=lambda q: (round(q.area, 3), _area_key(q)))
            u0, v0, u1, v1 = q.bounds
            if (u1 - u0) >= (v1 - v0):
                vc = round(0.5 * (v0 + v1), 1)
                strip = sbox(minx - 1, vc - cw / 2, maxx + 1, vc + cw / 2)
            else:
                uc = round(0.5 * (u0 + u1), 1)
                strip = sbox(uc - cw / 2, miny - 1, uc + cw / 2, maxy + 1)
            add = strip.intersection(pu)
            if add.area < 1.0:
                break
            C = unary_union([C, add])
            C = self._link(C, pu, cw)
        if C.is_empty:
            return None
        # make sure the entrance touches the network
        ep = Point(*ent_in)
        if C.distance(ep) > 1.0:
            from shapely.ops import nearest_points
            pc = nearest_points(C, ep)[0]
            r = self._route(ent_in, (pc.x, pc.y), pu, C, cw)
            if r is not None:
                C = unary_union([C, r])
        C = _clean(C.buffer(-0.45, join_style=2, mitre_limit=2.0).buffer(0.45, join_style=2, mitre_limit=2.0))
        return C

    def _stair_options(self, n: int):
        vs = self.vs
        sw = self.stair_w
        options = []
        for steep in (False, True):
            tr = 0.28 if not steep else 0.2
            tr = max(tr, vs) if vs <= 0.25 else vs
            nA = (n + 1) // 2
            LA = max(nA - 1, n - nA) * tr + sw
            options.append(("U", steep, tr, nA, LA, 2 * sw, LA + APRON))
            options.append(("S", steep, tr, n, n * tr, sw, n * tr + 2 * APRON))
        return options

    @_guard(lambda self,*a,**k: [])
    def place_cores(self, pu: Polygon, C, ent_in, n_cores: int):
        """Stair cores flush against the corridor network (apron inside the corridor), spread out by
        farthest-point sampling; the first core is the one nearest the entrance."""
        rises = [self.fy[i + 1] - self.fy[i] for i in range(self.n_eff - 1)]
        rise_rows = max(1, int(math.floor(0.2 / self.vs + 1e-9)))
        n = max(3, int(math.ceil(max(rises) / rise_rows)))
        prep = pu.buffer(-0.05)
        shapely.prepare(prep)
        edges = []
        for (p, q) in _segments(C.boundary):
            if abs(q[1] - p[1]) < 1e-6 and abs(q[0] - p[0]) >= 1.2:
                e = p[1]
                mx = 0.5 * (p[0] + q[0])
                above = C.contains(Point(mx, e + 0.1))
                edges.append((min(p[0], q[0]), max(p[0], q[0]), e, above))
        edges.sort(key=lambda t: (round(t[2], 3), round(t[0], 3)))
        for kind, steep, tr, nA, La, Wb, Ltot in self._stair_options(n):
            cand = []   # (px, py, direction, apron centre)
            for (x0, x1, e, above) in edges:
                self.check()
                xs = np.arange(x0 + 0.1, x1 - Wb - 0.1 + 1e-9, 0.5)
                if len(xs) == 0:
                    continue
                if above:       # corridor above the edge: body below it, apron at the top
                    py, d, ay = e - La, -1, e + APRON / 2
                else:
                    py, d, ay = e - APRON, 1, e - APRON / 2
                boxes = shapely.box(xs, py, xs + Wb, py + Ltot)
                ok = shapely.contains(prep, boxes)
                body_y0, body_y1 = (py, py + La) if d == -1 else (py + APRON, py + Ltot)
                bodies = shapely.box(xs, body_y0, xs + Wb, body_y1)
                ok &= shapely.area(shapely.intersection(bodies, C)) < 0.05
                ok &= ~((ent_in[0] >= xs - 0.7) & (ent_in[0] <= xs + Wb + 0.7) &
                        (ent_in[1] >= body_y0 - 0.7) & (ent_in[1] <= body_y1 + 0.7))
                for x in xs[ok]:
                    cand.append((float(x), float(py), d, (float(x + Wb / 2), float(ay))))
            if not cand:
                continue
            chosen = []
            first = min(cand, key=lambda c: (round(math.hypot(c[3][0] - ent_in[0], c[3][1] - ent_in[1]), 3), c[0], c[1]))
            chosen.append(first)
            while len(chosen) < n_cores:
                self.check()
                best = None
                for c in cand:
                    dmin = min(math.hypot(c[3][0] - o[3][0], c[3][1] - o[3][1]) for o in chosen)
                    if dmin < 12.0:
                        continue
                    key = (-round(dmin, 3), c[0], c[1])
                    if best is None or key < best[0]:
                        best = (key, c)
                if best is None:
                    break
                chosen.append(best[1])
            return [self._stair_spec(kind, steep, tr, nA, La, Wb, Ltot, n, px, py, 1, d) for (px, py, d, _) in chosen]
        return []

    @_guard(lambda self,*a,**k: [])
    def find_exits(self, pu: Polygon, C, ent, n_exits: int, existing_uv):
        """extra painted exits at corridor ends (ground floor), spread out; never over painted window boxes."""
        out = []
        if C is None or n_exits <= 0:
            return out
        cand = []
        edge_zone = pu.boundary.buffer(0.04)
        for (p, q) in _segments(C.boundary):
            L = math.hypot(q[0] - p[0], q[1] - p[1])
            if L >= 1.2 and edge_zone.covers(LineString([p, q])):
                cand.append((0.5 * (p[0] + q[0]), 0.5 * (p[1] + q[1])))
        cand.sort(key=lambda c: (round(c[0], 3), round(c[1], 3)))
        pts = list(existing_uv)
        zmask = self.zone_mask(self.bd.base_y + 1, self.bd.base_y + self.door_rows)
        while len(out) < n_exits and cand:
            self.check()
            best = None
            for c in cand:
                dmin = min(math.hypot(c[0] - o[0], c[1] - o[1]) for o in pts)
                if dmin < 15.0:
                    continue
                key = (-round(dmin, 3), c)
                if best is None or key < best[0]:
                    best = (key, c)
            if best is None:
                break
            c = best[1]
            cand.remove(c)
            E, N = self.world(c[0], c[1])
            e = self._ent_at("exit", (float(E), float(N)))
            cells = self.door_cells(e)
            if cells is None or zmask[cells[0], cells[1]].any():
                continue
            out.append(e)
            pts.append(c)
        return out

    # -- one part
    def plan_part(self, pu: Polygon, main: bool):
        vs = self.vs
        ent = self.find_entrance(pu, main)
        ent_in = self.inside_point(ent, pu)
        multi = self.n_eff > 1
        styles_all = [self.style_of(L, pu) for L in range(self.n_eff)]
        large = self.is_large(pu) and any(t in ("resid", "office") for t in styles_all)
        net = None
        cw = self.corridor_width()
        if large:
            net = self.corridor_net(pu, ent_in, cw)
            if net is None:
                large = False
        specs: list = []
        if multi:
            if pu.area < 9.0:
                if main:
                    self.warnings.append(("INTERIOR_SIMPLIFIED", "Footprint too small for stairs; ground floor only"))
                multi = False
            else:
                if large:
                    n_cores = max(1, min(12, int(math.ceil(pu.area / 600.0))))
                    specs = self.place_cores(pu, net, ent_in, n_cores)
                if not specs:
                    corr = any(t in ("resid", "office") for t in styles_all)
                    cw1 = 2.0 if self.kind in ("commercial", "civic") else 1.25
                    bu0, bv0, bu1, bv1 = pu.bounds
                    cor = None
                    if corr and not large and (bu1 - bu0) >= 3 * self.rmin and (bv1 - bv0) >= 2 * self.rmin + cw1:
                        cor = (round(0.5 * (bv0 + bv1), 1), cw1)
                    sp = self.place_stairs(pu, ent_in, 1 if corr else None, cor)
                    if sp is not None:
                        specs = [sp]
                        if large:
                            net = None      # stair could not be flush with the network: classic layout
                            large = False
                if not specs:
                    self.warnings.append(("INTERIOR_NO_STAIRS", "No room for a stair core; upper storeys not "
                                          "reachable" if main else "A wing has no stair core"))
        hall = body = None
        lift = None
        if specs:
            body = unary_union([sbox(*sp["body"]) for sp in specs])
            hall = unary_union([sbox(*a) for sp in specs for a in sp["aprons"]])
        n_eff_part = self.n_eff if specs else 1
        styles = [self.style_of(L, pu) for L in range(n_eff_part)]
        # circulation incl. the entrance route is fixed BEFORE the lift: the lift may only sit beside it
        self.cur_route = None
        circ = hall
        if any(t in ("resid", "office") for t in styles):
            c_parts = self._corr_parts(pu, specs, hall, net, ent_in)
            cu = unary_union(c_parts)
            if not cu.buffer(0.0).contains(Point(*ent_in)):
                self.cur_route = self._entry_route(ent_in, cu, pu, body)
                if self.cur_route is None:
                    self.warnings.append(("INTERIOR_SIMPLIFIED", "The entrance could not be linked to the "
                                          "stairs/corridor"))
            circ = unary_union(c_parts + ([self.cur_route] if self.cur_route is not None else [])
                               + ([hall] if hall is not None else [])).intersection(pu)
        if specs and self.n_eff > 5:
            lift = self.place_lift(pu, circ, body, Point(*ent_in).buffer(1.3))
            if lift is None:
                self.warnings.append(("INTERIOR_NO_LIFT", "No room for a lift shaft; stairs only"))
        exits = []
        if large and main and net is not None and len(specs) > 1:
            exits = self.find_exits(pu, net, ent, len(specs) - 1, [ent_in])
        geoms = {}

        def build(lift_):
            out = {}
            for st in sorted(set(styles)):
                self.check()
                try:
                    out[st] = self.layout(pu, st, specs, hall, body, lift_, ent_in, net if st in ("resid", "office") else None)
                except _GEOS_ERR as e:
                    log(f"interior: layout '{st}' degraded to one open room ({type(e).__name__}: {e})")
                    self.warnings.append(("INTERIOR_SIMPLIFIED", "Part of the room layout was simplified"))
                    out[st] = self._open_layout(pu, specs, lift_)
            return out
        geoms = build(lift)
        if lift is not None and any(r["type"] == "lift" and i in g.get("unreachable", [])
                                    for g in geoms.values() for i, r in enumerate(g["rooms"])):
            self.warnings.append(("INTERIOR_NO_LIFT", "The lift shaft could not get a door; stairs only"))
            lift = None
            geoms = build(None)
        return dict(pu=pu, ent=ent, ent_in=ent_in, spec=(specs[0] if specs else None), specs=specs, hall=hall,
                    body=body, lift=lift, n=n_eff_part, styles=styles, geoms=geoms, exits=exits, net=net,
                    large=large)

    def _open_layout(self, pu, specs, lift):
        rooms = [dict(poly=_clean(pu.difference(lift) if lift is not None else pu), circ=False, type="shop")]
        if lift is not None:
            rooms.append(dict(poly=lift, circ=False, type="lift"))
        return dict(rooms=rooms, doors=[], walls=[], entrance_room=0, links=[],
                    unreachable=[i for i, r in enumerate(rooms) if r["type"] == "lift"])

    def style_of(self, L: int, pu: Polygon) -> str:
        k, bt = self.kind, self.btype
        if k == "religious":
            return "nave"
        if k in ("industrial", "minor"):
            return "hall"
        small = pu.area < 16.0
        if L == 0:
            if small or bt in SHOP_TYPES or (k == "generic" and pu.area <= 600.0):
                return "open"
            if k in ("commercial", "civic", "generic"):
                return "office"
            return "resid"
        if k in ("commercial", "civic"):
            return "office"
        return "resid"

    # -- layout of one storey style
    def layout(self, pu: Polygon, style: str, specs, hall, body, lift, ent_in, net=None):
        """-> dict(rooms, doors, walls, entrance_room) with all rooms connected by doors."""
        rmin = self.rmin
        spec = specs[0] if specs else None
        large = net is not None
        zones = self.zone_polys_uv(-10 ** 9, 10 ** 9, 0.3 + self.hw_part)
        zone_union = unary_union(zones) if zones else None
        if zone_union is not None:
            shapely.prepare(zone_union)
        simple = style in ("open", "hall", "nave") or self.simp >= 2
        rooms: List[dict] = []
        if simple:
            open_region = pu.difference(lift) if lift is not None else pu
            rooms.append(dict(poly=_clean(open_region), circ=False,
                              type={"open": "shop", "hall": "industrial", "nave": "nave"}.get(style, "shop")))
            if lift is not None:
                rooms.append(dict(poly=lift, circ=False, type="lift"))
            return self.connect(rooms, ent_in, None, None)
        minx, miny, maxx, maxy = pu.bounds
        c_parts = self._corr_parts(pu, specs, hall, net, ent_in)
        avoid = unary_union([g for g in (body, lift) if g is not None]) if (body is not None or lift is not None) else None
        if getattr(self, "cur_route", None) is not None:
            c_parts.append(self.cur_route)
        cu = unary_union(c_parts).intersection(pu)
        seed_poly = hall if hall is not None else c_parts[0]
        keep = [p for p in _polys(cu) if p.distance(seed_poly) < 1e-6 or p.area >= 4.0]
        Cg = _clean(unary_union(keep).buffer(0.001).buffer(-0.001)) if keep else None
        if large and Cg is not None:
            core = Cg.buffer(-0.45, join_style=2, mitre_limit=2.0).buffer(0.45, join_style=2, mitre_limit=2.0)
            Cg = _clean(unary_union([core, hall]).buffer(0.001).buffer(-0.001)) if hall is not None else _clean(core)
        for p in (_polys(Cg) if Cg is not None else []):
            rooms.append(dict(poly=p, circ=True, type="stairhall" if (hall is not None and p.distance(hall) < 1e-6)
                              else "corridor"))
        fixed = unary_union([sbox(*sp["body"]) for sp in specs] + ([lift] if lift is not None else [])) \
            if (specs or lift is not None) else None
        rest = pu
        if Cg is not None:
            rest = rest.difference(Cg)
        if fixed is not None:
            rest = rest.difference(fixed)
        if Cg is not None and not rest.is_empty:
            # gaps narrower than 0.3 m between circulation and rooms/stairs are not rooms: they become circulation
            core = rest.buffer(-0.15, join_style=2, mitre_limit=2.0).buffer(0.15, join_style=2, mitre_limit=2.0)
            thin = [t for t in _polys(rest.difference(core)) if t.distance(Cg) < 1e-3]
            if thin:
                Cg = _clean(unary_union([Cg] + thin))
                rest = _clean(rest.difference(Cg))
                rooms = [r for r in rooms if not r["circ"]]
                for p in (_polys(Cg) if Cg is not None else []):
                    rooms.append(dict(poly=p, circ=True, type="stairhall" if (hall is not None and p.distance(hall) < 1e-6)
                                      else "corridor"))
        for sp in specs:
            rooms.append(dict(poly=sbox(*sp["body"]), circ=False, type="stairs"))
        if lift is not None:
            rooms.append(dict(poly=lift, circ=False, type="lift"))
        strip_axis = 0 if style == "office" else None
        max_area = (3.2 if style == "resid" else 3.4) * rmin * rmin
        strip_w = 4.2
        if large:           # rooms of about 5 x 7 m, at most ~8 x 6 m, every one touching a corridor
            max_area = 40.0 if style == "resid" else 48.0
            strip_w = 5.0
        for piece in sorted(_polys(rest), key=lambda p: (-p.area, _area_key(p))):
            if piece.area < 0.5:
                continue
            for lf in self._bsp(piece, max_area, rmin, zone_union, strip_axis, strip_w if strip_axis == 0 else None):
                for part in self._split_necks(lf):
                    rooms.append(dict(poly=part, circ=False, type="room"))
        for r in rooms:
            r["poly"] = _clean(r["poly"])
        rooms = [r for r in rooms if not r["poly"].is_empty and r["poly"].area > 0.2]
        rooms = self._resolve_overlaps(rooms)
        open_zone = unary_union([sbox(*a) for sp in specs for a in sp["aprons"]]) if specs else None
        return self.connect(rooms, ent_in, body, open_zone, need_access=large)

    def _resolve_overlaps(self, rooms):
        """rooms of one storey must not overlap: stairs/lift first, then circulation, then rooms."""
        order = sorted(range(len(rooms)), key=lambda i: (0 if rooms[i]["type"] in ("stairs", "lift") else
                                                          1 if rooms[i]["circ"] else 2, i))
        tree = shapely.STRtree([r["poly"] for r in rooms])
        out = {}
        for i in order:
            self.check()
            poly = rooms[i]["poly"]
            cut = []
            for j in sorted(int(x) for x in tree.query(poly)):
                if j in out and poly.intersection(out[j]["poly"]).area > 1e-6:
                    cut.append(out[j]["poly"])
            if cut:
                poly = _clean(poly.difference(unary_union(cut)))
            if poly.is_empty or poly.area < 0.2:
                continue
            r = dict(rooms[i])
            r["poly"] = poly
            out[i] = r
        return [out[i] for i in sorted(out)]

    def _extent_v(self, pu: Polygon, v: float) -> float:
        """Total v-extent of the part around the horizontal line at v (the strip it can host)."""
        minx, miny, maxx, maxy = pu.bounds
        ln = LineString([(minx - 1, v), (maxx + 1, v)]).intersection(pu)
        if ln.is_empty:
            return 0.0
        # use the cross extent at the middle of the line's longest piece
        segs = sorted(_segments(ln), key=lambda s: -abs(s[1][0] - s[0][0]))
        if not segs:
            return 0.0
        um = 0.5 * (segs[0][0][0] + segs[0][1][0])
        cr = LineString([(um, miny - 1), (um, maxy + 1)]).intersection(pu)
        if cr.is_empty:
            return 0.0
        sv = sorted(_segments(cr), key=lambda s: -abs(s[1][1] - s[0][1]))
        return abs(sv[0][1][1] - sv[0][0][1]) if sv else 0.0

    # -- recursive axis aligned split
    def _bsp(self, region, max_area, min_dim, zone_union, strip_axis, strip_w) -> List[Polygon]:
        leaves: List[Polygon] = []
        stack = list(reversed(_polys(region)))
        guard = 0
        while stack:
            self.check()
            guard += 1
            p = stack.pop()
            if p.area <= max_area or guard > 5000:
                leaves.append(p)
                continue
            res = self._try_split(p, min_dim, zone_union, strip_axis, strip_w)
            if res is None:
                leaves.append(p)
            else:
                stack.extend(reversed(res))
        return leaves

    @_guard(lambda self, lf: [lf])
    def _split_necks(self, lf: Polygon) -> List[Polygon]:
        """A room must be one walkable space: pieces joined only by a neck narrower than ~0.7 m (e.g. a room wrapped
        around a stair body) become separate rooms."""
        r = 0.35
        comps = _polys(lf.buffer(-r, join_style=2, mitre_limit=2.0))
        if len(comps) < 2:
            return [lf]
        out: List[Polygon] = []
        taken = Polygon()
        for c in sorted(comps, key=lambda c: (-c.area, _area_key(c))):
            part = _clean(lf.intersection(c.buffer(r + 0.02, join_style=2, mitre_limit=2.0)).difference(taken))
            for q in _polys(part):
                if q.area > 0.2:
                    out.append(q)
            taken = unary_union([taken, part]) if not part.is_empty else taken
        rest = _clean(lf.difference(taken))       # slivers of the neck go to the first part
        if out and rest is not None and not rest.is_empty:
            out[0] = _clean(unary_union([out[0], rest]))
            if out[0].geom_type != "Polygon":
                out[0] = max(_polys(out[0]), key=lambda q: q.area)
        return out or [lf]

    @_guard(lambda self,*a,**k: None)
    def _try_split(self, p: Polygon, min_dim, zone_union, strip_axis, strip_w):
        u0, v0, u1, v1 = p.bounds
        dims = (u1 - u0, v1 - v0)
        axes = [strip_axis, 1 - strip_axis] if strip_axis is not None else ([0, 1] if dims[0] >= dims[1] else [1, 0])
        amin = 0.7 * min_dim * min_dim
        for ax in axes:
            s0, s1 = (u0, u1) if ax == 0 else (v0, v1)
            lo, hi = s0 + min_dim, s1 - min_dim
            if strip_w is not None and ax == strip_axis and (s1 - s0) < 1.5 * strip_w:
                continue            # bay already narrow enough: split the other way
            if hi < lo - 1e-9:
                continue
            if strip_w is not None and ax == strip_axis:
                n = max(2, int(round((s1 - s0) / strip_w)))
                target = s0 + (s1 - s0) * (n // 2) / n
            else:
                target = s0 + (s1 - s0) * float(self.rng.uniform(0.38, 0.62))
            cands = np.arange(math.ceil(lo * 10 - 1e-9) / 10.0, hi + 1e-9, 0.1)
            if len(cands) == 0:
                continue
            order = np.argsort(np.abs(cands - target), kind="stable")
            for c in cands[order][:80]:
                self.check()
                c = float(round(c, 1))
                if ax == 0:
                    line = LineString([(c, v0 - 1), (c, v1 + 1)])
                    ra, rb = (u0 - 1, v0 - 1, c, v1 + 1), (c, v0 - 1, u1 + 1, v1 + 1)
                else:
                    line = LineString([(u0 - 1, c), (u1 + 1, c)])
                    ra, rb = (u0 - 1, v0 - 1, u1 + 1, c), (u0 - 1, c, u1 + 1, v1 + 1)
                cut = line.intersection(p)
                if cut.is_empty or cut.length < 0.8:
                    continue
                if zone_union is not None and shapely.intersects(zone_union, cut.buffer(self.hw_part + 0.05)):
                    continue
                pieces = _polys(shapely.clip_by_rect(p, *ra)) + _polys(shapely.clip_by_rect(p, *rb))
                if len(pieces) < 2:
                    continue
                if any(q.area < amin or (q.area < 0.4 * min_dim * q.length and q.buffer(-0.4 * min_dim).is_empty)
                       for q in pieces):
                    continue
                return sorted(pieces, key=_area_key)
        return None

    # -- adjacency, doors, connectivity
    @_guard(lambda self,*a,**k: [])
    def shared(self, a: Polygon, b: Polygon):
        """straight segments of b's boundary lying on a's boundary."""
        x0, y0, x1, y1 = b.bounds
        ab = shapely.clip_by_rect(a.boundary, x0 - 0.1, y0 - 0.1, x1 + 0.1, y1 + 0.1)
        if ab.is_empty:
            return []
        q0, q1, q2, q3 = ab.bounds
        g = shapely.clip_by_rect(b.boundary, q0 - 0.05, q1 - 0.05, q2 + 0.05, q3 + 0.05).intersection(
            ab.buffer(0.02, cap_style=2))
        return [(p, q) for (p, q) in _segments(g) if math.hypot(q[0] - p[0], q[1] - p[1]) > 0.05]

    @staticmethod
    def _slen(s):
        return math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1])

    @_guard(lambda self,segs,*a,**k: list(segs))
    def _cut(self, segs, region):
        """straight segments of `segs` after removing `region`."""
        if region is None or region.is_empty:
            return list(segs)
        out = []
        for (p, q) in segs:
            d = LineString([p, q]).difference(region)
            out += [(a, b) for (a, b) in _segments(d) if self._slen((a, b)) > 0.05]
        return out

    def _analyse(self, rooms, ent_in, forbid, open_zone):
        n = len(rooms)
        tree = shapely.STRtree([r["poly"].buffer(0.03) for r in rooms])
        adj: Dict[Tuple[int, int], list] = {}
        for i in range(n):
            self.check()
            for j in sorted(int(x) for x in tree.query(rooms[i]["poly"].buffer(0.03))):
                if j > i:
                    self.check()
                    sg = self.shared(rooms[i]["poly"], rooms[j]["poly"])
                    if sg:
                        adj[(i, j)] = sg
        ep = Point(*ent_in)
        er = min((i for i in range(n) if rooms[i]["type"] not in ("stairs", "lift")),
                 key=lambda i: (round(rooms[i]["poly"].distance(ep), 4), i), default=0)
        sites, links, walls = {}, set(), {}
        for (i, j), sg in adj.items():
            self.check()
            ti, tj = rooms[i]["type"], rooms[j]["type"]
            if "stairs" in (ti, tj):
                other = j if ti == "stairs" else i
                op = self._cut(sg, None)
                if rooms[other]["circ"] and open_zone is not None:
                    inside = [(a, b) for (a, b) in sg if open_zone.buffer(0.06).covers(LineString([a, b]))]
                    rest = self._cut(sg, open_zone.buffer(0.06))
                    if inside or len(rest) < len(sg):
                        links.add((i, j))
                    walls[(i, j)] = rest
                else:
                    walls[(i, j)] = sg
                continue
            walls[(i, j)] = sg
            if "lift" in (ti, tj):      # a lift shaft is a dead end: its only door opens onto circulation / the open room
                other = j if ti == "lift" else i
                if not (rooms[other]["circ"] or rooms[other]["type"] in ("shop", "industrial", "nave")):
                    continue
            ok = [x for x in self._cut(sg, forbid) if self._slen(x) >= DOOR_W + 0.4]
            if ok:
                sites[(i, j)] = max(ok, key=lambda x: (round(self._slen(x), 3), x))
        nbrs: Dict[int, list] = {i: [] for i in range(n)}
        for (i, j) in list(sites) + list(links):
            nbrs[i].append(j)
            nbrs[j].append(i)
        parent = {er: None}
        queue = [er]
        qi = 0
        while qi < len(queue):
            u = queue[qi]; qi += 1
            if rooms[u]["type"] == "lift":
                continue                    # never walk THROUGH a lift shaft
            for v in sorted(nbrs[u], key=lambda v: (not rooms[v]["circ"], v)):
                if v not in parent:
                    parent[v] = u
                    queue.append(v)
        return adj, sites, links, walls, er, parent

    def connect(self, rooms: List[dict], ent_in, body, open_zone, need_access=False):
        rmin = self.rmin
        forbid = body.buffer(0.55) if body is not None else None
        special = ("stairs", "lift")
        # 1. merge slivers into the neighbour they share most wall with (every pass merges or pins a room)
        for _ in range(4 * len(rooms) + 100):
            self.check()
            small = [i for i, r in enumerate(rooms) if not r["circ"] and r["type"] == "room" and not r.get("fixed")
                     and r["poly"].area < 0.6 * rmin * rmin]
            if not small:
                break
            i = min(small, key=lambda i: (rooms[i]["poly"].area, i))
            best = None
            for j, r in enumerate(rooms):
                if j == i or r["type"] in special:
                    continue
                L = sum(self._slen(x) for x in self.shared(rooms[i]["poly"], r["poly"]))
                if L > 0.3 and (best is None or (-round(L, 3), j) < best[0]):
                    best = ((-round(L, 3), j), j)
            if best is None:
                rooms[i]["fixed"] = True
                continue
            rooms = self._merge(rooms, i, best[1])
        # 1b. large floors: every room must open onto a corridor; merge the ones that cannot into a neighbour
        if need_access:
            rooms = self._ensure_access(rooms, forbid, special)
        # 2. connectivity: merge rooms that cannot get a door into a neighbour (strictly shrinks the room list)
        for _ in range(4 * len(rooms) + 100):
            self.check()
            adj, sites, links, walls, er, parent = self._analyse(rooms, ent_in, forbid, open_zone)
            lost = [i for i in range(len(rooms)) if i not in parent and rooms[i]["type"] not in special]
            if not lost:
                break
            i = min(lost, key=lambda i: (rooms[i]["poly"].area, i))
            cand = []
            for (a, b), sg in adj.items():
                if i in (a, b):
                    o = b if a == i else a
                    if rooms[o]["type"] not in special:
                        cand.append((-round(sum(self._slen(x) for x in sg), 3), o))
            if not cand:
                self.warnings.append(("INTERIOR_SIMPLIFIED", "A sealed room without neighbours was left out"))
                rooms = [r for k, r in enumerate(rooms) if k != i]
                continue
            rooms = self._merge(rooms, i, sorted(cand)[0][1])
        adj, sites, links, walls, er, parent = self._analyse(rooms, ent_in, forbid, open_zone)
        doors = []
        for v, u in sorted((v, u) for v, u in parent.items() if u is not None):
            key = (min(u, v), max(u, v))
            if key not in sites:
                continue            # open link (stairs apron): no door
            (p, q) = sites[key]
            L = self._slen((p, q))
            t0 = DOOR_W / 2 + 0.2
            t = t0 + (L - 2 * t0) * float(self.rng.uniform(0.25, 0.75))
            d = ((q[0] - p[0]) / L, (q[1] - p[1]) / L)
            doors.append(dict(a=u, b=v, c=(p[0] + d[0] * t, p[1] + d[1] * t), d=d))
        # last resort: a (possibly narrower) door through the longest wall to any reachable neighbour
        progress = True
        while progress:
            progress = False
            for i in range(len(rooms)):
                if i in parent or rooms[i]["type"] == "stairs":
                    continue
                best = None
                for (a, b), sg in sorted(adj.items()):
                    if i not in (a, b):
                        continue
                    j = b if a == i else a
                    if j not in parent or rooms[j]["type"] in ("stairs", "lift"):
                        continue
                    if rooms[i]["type"] == "lift" and not (rooms[j]["circ"] or rooms[j]["type"] in ("shop", "industrial", "nave")):
                        continue
                    for x in sg:
                        L = self._slen(x)
                        if L >= 0.5 and (best is None or (round(L, 3), x) > best[0]):
                            best = ((round(L, 3), x), j)
                if best is None:
                    continue
                (L, (p, q)), j = best
                w = min(DOOR_W, L - 0.2)
                c = (0.5 * (p[0] + q[0]), 0.5 * (p[1] + q[1]))
                d = ((q[0] - p[0]) / L, (q[1] - p[1]) / L)
                doors.append(dict(a=j, b=i, c=c, d=d, w=w))
                parent[i] = j
                progress = True
        wall_segs = []
        for (i, j), sg in sorted(walls.items()):
            wall_segs += [(i, j, p, q) for (p, q) in sg]
        reach = set(parent)
        unreachable = [i for i in range(len(rooms)) if i not in reach]
        if any(rooms[i]["type"] not in special for i in unreachable):
            self.warnings.append(("INTERIOR_SIMPLIFIED", f"{len(unreachable)} room(s) could not be connected by a door"))
        return dict(rooms=rooms, doors=doors, walls=wall_segs, entrance_room=er,
                    links=sorted(links), unreachable=unreachable)

    def _ensure_access(self, rooms, forbid, special, max_area=70.0):
        for _ in range(3):
            self.check()
            n = len(rooms)
            tree = shapely.STRtree([r["poly"].buffer(0.03) for r in rooms])
            access = [False] * n
            lens: Dict[Tuple[int, int], float] = {}
            for i in range(n):
                self.check()
                for j in sorted(int(x) for x in tree.query(rooms[i]["poly"].buffer(0.03))):
                    if j <= i:
                        continue
                    self.check()
                    sg = self.shared(rooms[i]["poly"], rooms[j]["poly"])
                    if not sg:
                        continue
                    lens[(i, j)] = sum(self._slen(x) for x in sg)
                    ci, cj = rooms[i]["circ"], rooms[j]["circ"]
                    if ci != cj:
                        ok = any(self._slen(x) >= DOOR_W + 0.4 for x in self._cut(sg, forbid))
                        if ok:
                            access[i if cj else j] = True
            lacking = [i for i in range(n) if not rooms[i]["circ"] and rooms[i]["type"] == "room" and not access[i]]
            if not lacking:
                break
            root = list(range(n))

            def find(a):
                while root[a] != a:
                    root[a] = root[root[a]]
                    a = root[a]
                return a
            area = [r["poly"].area for r in rooms]
            nbr: Dict[int, list] = {i: [] for i in range(n)}
            for (i, j), L in lens.items():
                nbr[i].append((j, L)); nbr[j].append((i, L))
            merged_any = False
            for i in sorted(lacking, key=lambda i: (area[i], i)):
                cands = [(not access[j], -round(L, 3), j) for (j, L) in nbr[i]
                         if L > 0.3 and not rooms[j]["circ"] and rooms[j]["type"] == "room"
                         and find(j) != find(i) and area[find(i)] + area[find(j)] <= max_area]
                if not cands:
                    continue
                j = sorted(cands)[0][2]
                a, b = find(i), find(j)
                root[a] = b
                area[b] += area[a]
                access[b] = access[b] or access[j]
                merged_any = True
            if not merged_any:
                break
            groups: Dict[int, list] = {}
            for i in range(n):
                groups.setdefault(find(i), []).append(i)
            new = []
            for g_, idx in sorted(groups.items()):
                if len(idx) == 1:
                    new.append(rooms[idx[0]])
                else:
                    nr = dict(rooms[idx[0]])
                    nr["poly"] = _clean(unary_union([rooms[k]["poly"] for k in idx]).buffer(0.01).buffer(-0.01))
                    new.append(nr)
            new.sort(key=lambda r: (not r["circ"], r["type"] != "stairs", _area_key(r["poly"])))
            rooms = new
        return rooms

    def _merge(self, rooms, i, o):
        merged = unary_union([rooms[i]["poly"], rooms[o]["poly"]]).buffer(0.01).buffer(-0.01)
        keep = rooms[o] if (rooms[o]["circ"] or rooms[o]["poly"].area >= rooms[i]["poly"].area) else rooms[i]
        nr = dict(keep)
        nr["poly"] = _clean(merged)
        out = [r for k, r in enumerate(rooms) if k not in (i, o)] + [nr]
        out.sort(key=lambda r: (not r["circ"], r["type"] != "stairs", _area_key(r["poly"])))
        return out

    def paint(self):
        """Rasterise the plans; if the result exceeds the voxel budget, drop fixtures, then partitions, and retry."""
        while True:
            res = self._paint_once()
            if res is _RETRY:
                continue
            if res is not None:
                break
            self.simp += 1
        if self.simp:
            self.warnings.append(("INTERIOR_SIMPLIFIED", "Large footprint or voxel budget: "
                                  + ("fixtures" if self.simp == 1 else "fixtures and partitions") + " skipped"))
        return res

    def _paint_once(self):
        vs = self.vs
        if not self.parts_plan:
            return _empty()
        # raster the plans once per (part, style)
        for pp in self.parts_plan:
            for st, g in pp["geoms"].items():
                self.check()
                g["raster"] = self.raster_geom(g)
        # budget
        est = self.estimate()
        budget = self.max_vox
        if budget is not None and est[0] + est[1] + est[2] > budget:
            self.simp = max(self.simp, 1)
        if budget is not None and est[0] + est[2] > budget:
            self.simp = max(self.simp, 2)
        if budget is not None and est[2] > budget:
            raise PipelineError("VOXEL_LIMIT", self.limit_message(est[2]))
        out = []
        rooms_total = 0
        plan_levels = []
        for pi, pp in enumerate(self.parts_plan):
            res = self.paint_part(pp, pi)
            out += res[0]
            rooms_total += res[1]
            plan_levels.append(res[2])
        # outer wall extra layers + entrance door
        out += self.paint_shell()
        if not any(len(o[0]) for o in out):
            self.det.rooms = rooms_total
            return _empty()
        # dedupe (last wins), sorted by (x, z, y); slice-wise so cancel checks stay frequent and memory stays flat
        self.check()
        X, Y, Z, Cd = merge_unique(out, self.grid.nz, self.check)
        xyz = np.empty((len(X), 3), np.int32)
        xyz[:, 0], xyz[:, 1], xyz[:, 2] = X, Y, Z
        del X, Y, Z
        codes = Cd
        if self.max_vox is not None and len(xyz) > self.max_vox:
            if self.simp < 2:
                return None
            raise PipelineError("VOXEL_LIMIT", self.limit_message(len(xyz)))
        if self.simp >= 2:      # no partitions: one open space per storey
            rooms_total = sum(pp["n"] for pp in self.parts_plan)
        self.det.rooms = rooms_total
        self.det.doors_added = int(self._painted_doors)
        if self.simp < 2 and self.n_free <= DISC_CHECK_MAX_CELLS and len(plan_levels) and self.max_levels_checked():
            try:
                bad = self._unreachable_rooms(xyz, plan_levels)
            except Exception as e:      # validation must never fail the interior
                log(f"interior: disc reachability check failed ({type(e).__name__}: {e})")
                bad = []
            if bad and self.door_extra < DOOR_EXTRA_MAX - 1e-9:
                self.door_extra = round(self.door_extra + 0.2, 2)
                return _RETRY
            if bad and not self.no_fix and self.simp < 1:       # last repair: leave the rooms unfurnished
                self.no_fix = True
                self.warnings.append(("INTERIOR_SIMPLIFIED", "Furniture left out so every room can be entered"))
                return _RETRY
            if bad:
                self.warnings.append(("ROOM_UNREACHABLE", f"{len(bad)} room(s) cannot be entered by a 0.6 m wide "
                                      "body (narrow or jagged doorways); they are left as they are"))
        try:
            self.det.entrances_raw = self.compute_entrances(xyz)
        except Exception as e:      # metadata only: never fail the interior because of it
            log(f"interior: entrances failed ({type(e).__name__}: {e})")
            self.det.entrances_raw = []
        built = max(pp["n"] for pp in self.parts_plan)
        self.det.levels_built = built
        self.det.floor_ys_built = list(self.fy[:built])
        seen_w = []
        for w_ in self.warnings:
            if w_ not in seen_w:
                seen_w.append(w_)
        self.warnings[:] = seen_w
        self.det.interior_plan = SimpleNamespace(parts=plan_levels, floor_ys=list(self.fy), top_rows=list(self.top_rows),
                                                 vs=vs, simplified=self.simp, D=self.D, x0=self.x0, z0=self.z0,
                                                 free=self.free, zones=self.zones)
        return xyz, codes

    # -- disc reachability (the walking client is a 0.6 m wide disc): validate the final voxels of every storey
    def max_levels_checked(self) -> bool:
        return len(self.fy) <= 12

    def _unreachable_rooms(self, xyz: np.ndarray, plan_levels: list) -> list:
        """-> [(part, level, room)] of rooms (not stairs / lifts) that a 0.6 m disc standing on the storey floor cannot
        reach from the room the storey is entered from (entrance room on the ground floor, the stair hall above). The
        disc rests on the highest voxel under its footprint, needs 1.8 m clear above and moves in 8 directions (no
        squeezing between two diagonal corners)."""
        vs = self.vs
        head = int(math.ceil(1.8 / vs - 1e-9))
        R = 0.3 - 1e-6
        n = int(math.ceil(R / vs)) + 1
        offs = []
        for dx in range(-n, n + 1):
            for dz in range(-n, n + 1):
                ax, az = max(abs(dx) * vs - vs / 2, 0.0), max(abs(dz) * vs - vs / 2, 0.0)
                if ax * ax + az * az < R * R:
                    offs.append((dx, dz))
        m = n + 1
        H, W = self.h + 2 * m, self.w + 2 * m
        A = np.asarray(xyz, np.int64).reshape(-1, 3)
        shell = [getattr(self.bd, k, None) for k in ("wx", "wy", "wz")]
        shell = np.column_stack([np.asarray(a, np.int64) for a in shell]) if all(a is not None and len(a) for a in shell) \
            else np.empty((0, 3), np.int64)
        bad = []

        def shifted(a, dx, dz):
            out = np.zeros_like(a)
            xs0, xs1, zs0, zs1 = max(0, dz), H + min(0, dz), max(0, dx), W + min(0, dx)
            out[xs0:xs1, zs0:zs1] = a[xs0 - dz:xs1 - dz, zs0 - dx:zs1 - dx]
            return out

        def dilate(a):
            o = np.zeros_like(a)
            for dx, dz in offs:
                o |= shifted(a, dx, dz)
            return o
        for L in range(min(len(self.fy), max(len(p["levels"]) for p in plan_levels))):
            y = self.fy[L] + 1
            blocked = np.zeros((H, W), bool)
            below = np.zeros((H, W), bool)
            for D_ in (A, shell):
                if not len(D_):
                    continue
                sel = (D_[:, 1] >= y - 1) & (D_[:, 1] < y + head)
                B = D_[sel]
                col = B[:, 0] - self.x0 + m
                row = B[:, 2] - self.z0 + m
                ok = (col >= 0) & (col < W) & (row >= 0) & (row < H)
                B, col, row = B[ok], col[ok], row[ok]
                up = B[:, 1] >= y
                blocked[row[up], col[up]] = True
                below[row[~up], col[~up]] = True
            S = dilate(below) & ~dilate(blocked)
            for pi, pp in enumerate(plan_levels):
                if L >= len(pp["levels"]):
                    continue
                lv = pp["levels"][L]
                rooms = lv["rooms"]
                if not rooms:
                    continue
                er = lv["entrance_room"] if 0 <= lv["entrance_room"] < len(rooms) else 0
                seed_poly = rooms[er]["poly_uv"]
                pt = seed_poly.buffer(-0.25).representative_point() if not seed_poly.buffer(-0.25).is_empty \
                    else seed_poly.representative_point()
                if L == 0 and pp.get("ent_in") is not None:
                    pt = Point(*pp["ent_in"])
                E, N = self.world(pt.x, pt.y)
                c0 = int(math.floor((E - self.grid.e0) / vs)) - self.x0 + m
                r0 = int(math.floor((self.grid.n0 - N) / vs)) - self.z0 + m
                seed = None
                for rad in range(0, int(0.6 / vs) + 2):
                    cand = [(r0 + a, c0 + b) for a in range(-rad, rad + 1) for b in range(-rad, rad + 1)
                            if 0 <= r0 + a < H and 0 <= c0 + b < W and S[r0 + a, c0 + b]]
                    if cand:
                        seed = min(cand, key=lambda t: (abs(t[0] - r0) + abs(t[1] - c0), t))
                        break
                reached = np.zeros((H, W), bool)
                if seed is None:
                    seed_ok = False
                else:
                    seed_ok = True
                    reached[seed] = True
                    front = reached.copy()
                    while front.any():
                        new = np.zeros_like(front)
                        for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                            f = front
                            if dx and dz:       # no squeezing between two diagonal corners
                                f = front & (shifted(S, -dx, 0) | shifted(S, 0, -dz))
                            new |= shifted(f, dx, dz)
                        new &= S & ~reached
                        reached |= new
                        front = new
                for ri, r in enumerate(rooms):
                    if r["type"] in ("stairs", "lift"):
                        continue
                    poly = r["poly_uv"].buffer(-0.25)
                    if poly.is_empty:
                        poly = r["poly_uv"].buffer(-0.1)
                    if poly.is_empty:
                        continue
                    mask = np.zeros((self.h, self.w), bool)
                    self._poly_mask(poly, mask)
                    if not mask.any():
                        continue
                    if not seed_ok or not (reached[m:m + self.h, m:m + self.w] & mask).any():
                        bad.append((pi, L, ri))
        return bad

    # -- walking demo: entrances (metadata only; never changes a voxel)
    def _opening_door_for(self, pt):
        """the painted facade door opening whose centre is nearest to world point pt (or None)."""
        best = None
        for o in self.openings:
            if o.get("kind") != "door":
                continue
            E = self.grid.e0 + 0.5 * (o["x0"] + o["x1"]) * self.vs
            N = self.grid.n0 - 0.5 * (o["z0"] + o["z1"]) * self.vs
            d = math.hypot(E - pt[0], N - pt[1])
            if best is None or d < best[0]:
                best = (d, o)
        return best[1] if best else None

    def compute_entrances(self, xyz: np.ndarray) -> list:
        """One record per usable door of the ground floor: ``dict(pt (E,N) of the door on the outline, n_in (E,N)
        unit, inside/outside = feet [x, y, z] in metres of the detail .vwg frame (voxel index * voxel size, cell
        centres), dir = [x, z] outside->inside, widthM, kind)``. Candidates are verified against the final voxels
        (interior + exterior shell): walkable floor, >= 2 m headroom and a 0.6 m wide clear column. Doors that do
        not lead from outside into a walkable space are skipped (warning ENTRANCE_UNUSABLE)."""
        vs, grid = self.vs, self.grid
        fy0 = int(self.fy[0])
        y = fy0 + 1                                  # feet row (the floor voxel is fy0)
        r = int(0.3 / vs + 1e-9)                     # 0.6 m wide body: cell offsets -r..r
        hr_full = int(math.ceil(2.0 / vs - 1e-9))
        hr_min = int(math.ceil(1.85 / vs - 1e-9))
        hr_out = int(math.ceil(1.8 / vs - 1e-9))
        ceil_row = int(self.top_rows[0])             # last free row below the first slab (inclusive)
        members = list(getattr(self.det, "members", None) or [self.bd])
        union = unary_union([m.poly for m in members if m.poly is not None and not m.poly.is_empty]).buffer(0.02)
        xyz = np.asarray(xyz).reshape(-1, 3)
        shell = [np.asarray(getattr(self.bd, k, None) if getattr(self.bd, k, None) is not None else [], np.int64)
                 for k in ("wx", "wy", "wz")]
        shell = np.column_stack(shell) if len(shell[0]) else np.empty((0, 3), np.int64)
        ents = [pp["ent"] for pp in self.parts_plan] + [e for pp in self.parts_plan for e in pp["exits"]]
        out: list = []
        loc: list = [xyz, shell]
        Hm = max(hr_full, hr_out) + 2
        rc = int(math.ceil(1.2 / vs))                # local search window (cells around a candidate)
        R = r + rc

        def cell_of(E, N):
            return (int(math.floor((E - grid.e0) / vs)), int(math.floor((grid.n0 - N) / vs)))

        def window(cx, cz, rad):
            """bool occupancy [x, y (rel. y-1), z] around cell (cx, cz), radius rad cells."""
            x0, z0 = cx - rad, cz - rad
            n = 2 * rad + 1
            occ = np.zeros((n, Hm + 1, n), bool)
            for A in loc:
                if not len(A):
                    continue
                m = ((A[:, 0] >= x0) & (A[:, 0] < x0 + n) & (A[:, 2] >= z0) & (A[:, 2] < z0 + n)
                     & (A[:, 1] >= y - 1) & (A[:, 1] <= y - 1 + Hm))
                B = A[m]
                occ[B[:, 0] - x0, B[:, 1] - (y - 1), B[:, 2] - z0] = True
            return occ

        disc = np.array([[math.hypot(a, b) * vs <= 0.3 + 1e-9 for b in range(-r, r + 1)] for a in range(-r, r + 1)])
        knee = int(math.ceil(0.4 / vs - 1e-9))

        def clear_col(occ, ix, iz, hr, need_floor):
            """round body (radius 0.3 m) at local cell (ix, iz): the centre column is free for hr rows from the feet
            row, the rest of the disc above a 0.4 m knee (a tread / threshold beside the centre is stepped over),
            and there is a floor under the centre cell."""
            sl = occ[ix - r:ix + r + 1, :, iz - r:iz + r + 1]
            if sl.shape[0] != 2 * r + 1 or sl.shape[2] != 2 * r + 1:
                return False
            if sl[r, 1:1 + hr, r].any() or sl.transpose(0, 2, 1)[disc][:, 1 + knee:1 + hr].any():
                return False
            return not (need_floor and not sl[r, 0, r])

        for ent in ents:
            pt = (float(ent["pt_b"][0]), float(ent["pt_b"][1]))
            n_in = (float(ent["n_in"][0]), float(ent["n_in"][1]))
            tan = (float(ent["tan"][0]), float(ent["tan"][1]))
            ln = math.hypot(*n_in) or 1.0
            n_in = (n_in[0] / ln, n_in[1] / ln)
            if ent.get("kind") == "openings":
                o = self._opening_door_for(pt)
                if o is None:
                    width = 0.0
                else:
                    dx, dz = (o["x1"] - o["x0"]) * vs, (o["z1"] - o["z0"]) * vs
                    width = (dx * abs(tan[0]) + dz * abs(tan[1])) / ((tan[0] ** 2 + tan[1] ** 2) or 1.0)
                width = round(width, 3)
            else:
                width = round(DOOR_W, 3)
            if width < DOOR_W - 1e-6:       # narrow (scaled) facade door: the doorway is widened to 0.9 m when carved
                width = round(DOOR_W, 3)
            # only the voxels near this door matter: prefilter once (the candidate loop below looks at them often)
            ex, ez = cell_of(*pt)
            rb = int(math.ceil((2.5 + self.D * vs) / vs)) + R + 2
            loc = []
            for A in (xyz, shell):
                if len(A):
                    m = ((np.abs(A[:, 0] - ex) <= rb) & (np.abs(A[:, 2] - ez) <= rb)
                         & (A[:, 1] >= y - 1) & (A[:, 1] <= y - 1 + Hm))
                    A = A[m]
                loc.append(A)
            inner = (self.D + 1) * vs
            base_d = max(0.6, inner + 0.3)
            ds = []
            for k in (0.0, 0.1, 0.2, -0.1, 0.3, 0.4, 0.5):
                d = round(base_d + k, 3)
                if d >= inner + 0.15 and d not in ds:
                    ds.append(d)
            res_in = None
            best = None         # fallback: the clear candidate with the most room around it
            for hr0 in (hr_full, hr_min):
                hr = min(hr0, ceil_row - y + 1)
                if hr < hr_min:
                    break
                for d in ds:
                    for lt in (0.0, vs, -vs, 2 * vs, -2 * vs):
                        cx, cz = cell_of(pt[0] + n_in[0] * d + tan[0] * lt, pt[1] + n_in[1] * d + tan[1] * lt)
                        occ = window(cx, cz, R)
                        if not clear_col(occ, R, R, hr, True):
                            continue
                        # not a pocket: the clear floor connected to the cell has to reach 0.9 m away (or fill 0.5 m2)
                        ok2 = {(ax, az) for ax in range(-rc, rc + 1) for az in range(-rc, rc + 1)
                               if clear_col(occ, R + ax, R + az, hr, True)}
                        seen, stack = {(0, 0)}, [(0, 0)]
                        while stack:
                            ax, az = stack.pop()
                            for q in ((ax + 1, az), (ax - 1, az), (ax, az + 1), (ax, az - 1)):
                                if q in ok2 and q not in seen:
                                    seen.add(q)
                                    stack.append(q)
                        reach = max(max(abs(ax), abs(az)) for ax, az in seen)
                        if reach * vs >= 0.9 or len(seen) * vs * vs >= 0.5:
                            res_in = (cx, cz)
                            break
                        if best is None or (reach, len(seen)) > best[0]:
                            best = ((reach, len(seen)), (cx, cz))
                    if res_in:
                        break
                if res_in:
                    break
            if res_in is None and best is not None and best[0][1] >= 4:
                res_in = best[1]
            res_out = None
            if res_in:
                for d in (0.8, 0.7, 0.9, 0.6, 1.0):
                    E, N = pt[0] - n_in[0] * d, pt[1] - n_in[1] * d
                    if union.contains(Point(E, N)):
                        continue
                    cx, cz = cell_of(E, N)
                    occ = window(cx, cz, r + 1)
                    if occ[:, 1:1 + hr_out, :].any():
                        continue
                    res_out = (cx, cz)
                    break
            if not res_in or not res_out:
                self.warnings.append(("ENTRANCE_UNUSABLE", "A door has no " + (
                    "walkable floor behind it" if not res_in else "clear ground in front of it")
                    + "; not used as an entrance"))
                continue
            (ix, iz), (ox, oz) = res_in, res_out
            ce = lambda c, r_: (grid.e0 + (c + 0.5) * vs, grid.n0 - (r_ + 0.5) * vs)
            d_in = (ce(ix, iz)[0] - pt[0]) * n_in[0] + (ce(ix, iz)[1] - pt[1]) * n_in[1]
            d_out = -((ce(ox, oz)[0] - pt[0]) * n_in[0] + (ce(ox, oz)[1] - pt[1]) * n_in[1])
            out.append(dict(
                pt=pt, n_in=n_in, tan=tan, dIn=round(d_in, 4), dOut=round(d_out, 4), kind=ent.get("kind"),
                widthM=width,
                inside=[round((ix + 0.5) * vs, 4), round(y * vs, 4), round((iz + 0.5) * vs, 4)],
                outside=[round((ox + 0.5) * vs, 4), round(y * vs, 4), round((oz + 0.5) * vs, 4)],
                dir=[round(n_in[0], 4), round(-n_in[1], 4)]))
        return out

    def raster_geom(self, g):
        """walls / door cells (2D masks) for a storey geometry; room-id raster is made per level."""
        W = np.zeros((self.h, self.w), bool)
        Dm = np.zeros((self.h, self.w), bool)
        if self.simp >= 2:
            return dict(W=W, D=Dm)
        for (i, j, p, q) in g["walls"]:
            self.check()
            L = math.hypot(q[0] - p[0], q[1] - p[1])
            if L < 1e-6:
                continue
            # normal in world: rotate frame normal
            nu, nv = -(q[1] - p[1]) / L, (q[0] - p[0]) / L
            nx = nu * self.cs - nv * self.sn
            nz_ = nu * self.sn + nv * self.cs
            hw = max(self.hw_part, 0.5 * self.vs * (abs(nx) + abs(nz_))) + 1e-6
            rr, cc = self.band(p, q, hw)
            W[rr, cc] = True
        for d in g["doors"]:
            c, dd = d["c"], d["d"]
            dwid = d.get("w", DOOR_W) + self.door_extra
            p = (c[0] - dd[0] * dwid / 2, c[1] - dd[1] * dwid / 2)
            q = (c[0] + dd[0] * dwid / 2, c[1] + dd[1] * dwid / 2)
            nx = abs(-dd[1] * self.cs - dd[0] * self.sn) + abs(-dd[1] * self.sn + dd[0] * self.cs)
            hw = max(self.hw_part, 0.5 * self.vs * nx) + 1e-6 + self.vs
            rr, cc = self.band(p, q, hw, ext=0.0)      # exactly the door width along the wall
            Dm[rr, cc] = True
        return dict(W=W, D=Dm)

    def estimate(self):
        """(walls+fixtures estimate, fixtures estimate, slab count) in voxels."""
        n_lv = self.n_eff
        slab = 0
        walls = 0
        for pp in self.parts_plan:
            for L in range(pp["n"]):
                g = pp["geoms"][pp["styles"][L]]
                slab += int(self.free.sum()) * (self.st if L else 1)
                rows = self.top_rows[L] - self.fy[L]
                walls += int(g["raster"]["W"].sum()) * rows
        fix = int(0.04 * slab) if self.simp < 1 else 0
        shell = int(self.ring.sum()) * (int(self.bd.eave_y) - self.bd.base_y)
        return walls + shell, fix, slab

    # -- per part painting
    def paint_part(self, pp, pi):
        vs, st = self.vs, self.st
        out = []
        n = pp["n"]
        specs = pp["specs"] if n > 1 else []
        spec = pp["spec"]
        rooms_total = 0
        levels_info = []
        # stair geometry (once per core)
        sdata = []
        hole_stair = np.zeros((self.h, self.w), bool)
        for sp in specs:
            s_rr, s_cc, s_a, s_b = self.stair_cells(sp)
            sdata.append((sp, s_rr, s_cc, self.step_index(sp, s_a, s_b), self.spine_cells(sp, s_a, s_b)))
            hole_stair[s_rr, s_cc] = True
        lift_cells = None
        hole_lift = np.zeros((self.h, self.w), bool)
        if pp["lift"] is not None:
            rr, cc = self.urect(*pp["lift"].bounds)
            hole_lift[rr, cc] = self.free[rr, cc]
        part_mask = np.zeros((self.h, self.w), bool)
        rr, cc = self.urect(*pp["pu"].buffer(0.5 * vs).bounds)
        part_mask[rr, cc] = True
        pu_mask = np.zeros((self.h, self.w), bool)
        pb = pp["pu"].buffer(0.9 * vs)
        self._poly_mask(pb, pu_mask)
        part_free = self.free & pu_mask
        for L in range(n):
            self.check()
            g = pp["geoms"][pp["styles"][L]]
            rooms = g["rooms"]
            lo, hi = self.fy[L] + 1, self.top_rows[L]
            top_ = self.top_rows[L]
            zone = self.zone_mask(lo, hi)
            types = self.assign_types(rooms, pp["styles"][L], L)
            # room id raster
            rid = np.full((self.h, self.w), -1, np.int32)
            for k, r in enumerate(rooms):
                self.check()
                self._label(r["poly"], k, rid)
            # slabs
            hole = np.zeros((self.h, self.w), bool)
            if L > 0:
                hole |= hole_lift
                if specs:
                    hole |= hole_stair
            cells = part_free & ~hole
            rr, cc = np.nonzero(cells)
            lut = self.floor_lut(types)
            rcol = lut[np.where(rid[rr, cc] >= 0, rid[rr, cc], len(types))]
            pat = self.floor_pattern(rr, cc, types, rid)
            fcol = np.clip(rcol.astype(np.float64) * pat[:, None] * self.floor_shade, 0, 255).astype(np.uint8)
            s_top = self.fy[L]
            out.append(self.vox(rr, cc, s_top, s_top + 1, fcol, MO))     # floor surface ("other")
            if L > 0:
                for y in range(s_top - st + 1, s_top):
                    out.append(self.vox(rr, cc, y, y + 1, np.tile(_rgb(C_SLAB), (len(rr), 1)), MW))
            self.det_slab_rows = st
            # partitions
            if self.simp < 2:
                W = g["raster"]["W"] & part_free & ~zone & ~hole
                Dm = g["raster"]["D"] & W
                top = self.top_rows[L]
                dtop = min(top - 1, s_top + self.door_rows)
                rr, cc = np.nonzero(W & ~Dm)
                out.append(self.vox(rr, cc, lo, top + 1, np.tile(_rgb(C_PLASTER), (len(rr), 1)), MW))
                rr, cc = np.nonzero(Dm)
                if dtop + 1 <= top:
                    out.append(self.vox(rr, cc, dtop + 1, top + 1, np.tile(_rgb(C_PLASTER), (len(rr), 1)), MW))
            # stairs up from this level
            for (sp, s_rr, s_cc, s_k, s_spine) in (sdata if L < n - 1 else []):
                R = self.fy[L + 1] - self.fy[L]
                kk = s_k
                ytop = self.fy[L] + np.round(kk * R / sp["n"]).astype(np.int64)
                ytop = np.maximum(ytop, self.fy[L] + 1)
                if L == 0:      # ground flight: solid blocks; upper flights are thin zig-zag treads (head room below)
                    ybot = np.full(len(kk), self.fy[L] + 1, np.int64)
                else:
                    thick = max(2, int(round(max(0.25, 2.0 * R / sp["n"] * vs) / vs)))
                    # the flight below must keep STAIR_HEAD of vertical head room above every tread (+1 row for the
                    # rounding of the per-flight step heights): upper flights are thin zig-zag treads
                    head_rows = int(math.ceil(STAIR_HEAD / vs - 1e-9)) + 1
                    r_min = min(self.fy[L] - self.fy[L - 1], R)
                    thick = max(1, min(thick, r_min - head_rows))
                    ybot = np.maximum(self.fy[L] + 1, ytop - thick + 1)
                cnt = ytop - ybot + 1
                rep_ = np.repeat(np.arange(len(kk)), cnt)
                off = np.arange(int(cnt.sum())) - np.repeat(np.cumsum(cnt) - cnt, cnt)
                yy = np.repeat(ybot, cnt) + off
                is_top = (yy == np.repeat(ytop, cnt))
                col = np.where(is_top[:, None], _rgb(C_STAIR)[None, :], _rgb(C_STAIR_SIDE)[None, :])
                out.append([(self.x0 + s_cc[rep_]).astype(np.int32), yy.astype(np.int32),
                            (self.z0 + s_rr[rep_]).astype(np.int32), self.pk(col, MW)])
                # U stairs: a thin wall between the two lanes (storey high) so nobody stands on the rim of the other
                # lane's treads (they differ by up to a storey) and the walker cannot clip the jagged edge
                if len(s_spine[0]):
                    sr_, sc_ = s_spine
                    out.append(self.vox(sr_, sc_, lo, top_ + 1, np.tile(_rgb(C_STAIR_SIDE), (len(sr_), 1)), MW))
            # fixtures
            if self.simp < 1 and not self.no_fix:
                try:
                    out += self.fixtures(pp, g, rooms, types, L, rid, zone)
                except _GEOS_ERR as e:       # degenerate geometry: this storey stays unfurnished, the interior survives
                    log(f"interior: fixtures of storey {L} skipped ({type(e).__name__}: {e})")
                    self.warnings.append(("INTERIOR_SIMPLIFIED", "Some rooms could not be furnished"))
            rn = sum(1 for k, r in enumerate(rooms) if not r["circ"] and types[k] not in ("lift", "stairs"))
            rooms_total += max(1, rn) if rooms else 0
            levels_info.append(dict(level=L, types=types, rooms=[dict(poly_uv=r["poly"], circ=r["circ"], type=types[k])
                                                                    for k, r in enumerate(rooms)],
                                    doors=[(d["a"], d["b"], d["c"]) for d in g["doors"]],
                                    entrance_room=g["entrance_room"], links=g.get("links", []), unreachable=g.get("unreachable", []),
                                    style=pp["styles"][L],
                                    slab_top=s_top, ceil=self.top_rows[L]))
        # stair room per level (room containing the stair apron)
        info = dict(levels=levels_info, spec=spec, specs=pp["specs"], exits=pp["exits"], large=pp["large"],
                    net=pp["net"], ent=pp["ent"], ent_in=pp["ent_in"], frame=(self.Ec, self.Nc, self.ang))
        if spec is not None:
            o, ea, eb = spec["o"], spec["ea"], spec["eb"]
            ap = (o[0] - ea[0] * APRON / 2 + eb[0] * spec["Wb"] / 2, o[1] - ea[1] * APRON / 2 + eb[1] * spec["Wb"] / 2)
            info["stair_apron_uv"] = ap
        return out, rooms_total, info

    @_guard(lambda self,*a,**k: None)
    def _poly_mask(self, geom, mask):
        for p in _polys(geom):
            u0, v0, u1, v1 = p.bounds
            rr, cc = self.urect(u0 - 0.01, v0 - 0.01, u1 + 0.01, v1 + 0.01)
            if len(rr) == 0:
                continue
            for o in range(0, len(rr), 400_000):        # bounded work between cancel checks
                self.check()
                r_, c_ = rr[o:o + 400_000], cc[o:o + 400_000]
                U, V = self.uv(self.cell_E(c_), self.cell_N(r_))
                m = shapely.contains_xy(p, U, V)
                mask[r_[m], c_[m]] = True

    @_guard(lambda self,*a,**k: None)
    def _label(self, poly, k, rid):
        pb = poly.buffer(0.75 * self.vs)
        for p in _polys(pb):
            u0, v0, u1, v1 = p.bounds
            rr, cc = self.urect(u0 - 0.01, v0 - 0.01, u1 + 0.01, v1 + 0.01)
            if len(rr) == 0:
                continue
            for o in range(0, len(rr), 400_000):
                self.check()
                r_, c_ = rr[o:o + 400_000], cc[o:o + 400_000]
                U, V = self.uv(self.cell_E(c_), self.cell_N(r_))
                m = shapely.contains_xy(p, U, V)
                rid[r_[m], c_[m]] = k

    def pk(self, rgb: np.ndarray, mat: int) -> np.ndarray:
        rgb = np.asarray(rgb, np.uint32).reshape(-1, 3)
        c = (rgb[:, 0] << 16) | (rgb[:, 1] << 8) | rgb[:, 2]
        return (c << 3) | np.uint32(mat)

    def vox(self, rr, cc, y0, y1, rgb, mat):
        """prism of rows y0..y1-1 over cells (rr, cc); rgb (n,3) per cell. int32 coordinates, uint32 codes."""
        n = len(rr)
        ny = max(0, y1 - y0)
        if n == 0 or ny == 0:
            return [np.empty(0, np.int32)] * 3 + [np.empty(0, np.uint32)]
        X = np.repeat((self.x0 + np.asarray(cc)).astype(np.int32), ny)
        Z = np.repeat((self.z0 + np.asarray(rr)).astype(np.int32), ny)
        Y = np.tile(np.arange(y0, y1, dtype=np.int32), n)
        C = np.repeat(self.pk(rgb, mat), ny)
        return [X, Y, Z, C]

    # -- rooms: types, floors
    def assign_types(self, rooms, style, L):
        n = len(rooms)
        types = ["corridor" if r["circ"] else "room" for r in rooms]
        for k, r in enumerate(rooms):
            if r["circ"]:
                types[k] = r.get("type", "corridor") if r.get("type") in ("stairhall", "corridor") else "corridor"
            elif r["type"] in ("lift", "shop", "industrial", "nave", "stairs"):
                types[k] = r["type"]
        idx = sorted([k for k in range(n) if types[k] == "room"], key=lambda k: (-rooms[k]["poly"].area, k))
        m = len(idx)
        if not m:
            return types
        if style == "office":
            for k in idx:
                types[k] = "office"
            if m >= 4:
                types[idx[-1]] = "wc"
            if rooms[idx[0]]["poly"].area >= 30:
                types[idx[0]] = "meeting"
        else:  # resid
            if L == 0:
                order = ["living", "kitchen"]
                for t, k in zip(order, idx):
                    types[k] = t
                rest = idx[2:]
                for k in rest:
                    types[k] = "dining" if rooms[k]["poly"].area >= 14 else "study"
                if m >= 4 and rooms[idx[-1]]["poly"].area < 9:
                    types[idx[-1]] = "wc"
            else:
                for k in idx:
                    types[k] = "bedroom"
                if m >= 2 and rooms[idx[-1]]["poly"].area < 10:
                    types[idx[-1]] = "bath"
                if m >= 6 and rooms[idx[-2]]["poly"].area < 12:
                    types[idx[-2]] = "bath"
                if m >= 3:
                    types[idx[0]] = "living" if rooms[idx[0]]["poly"].area > 22 else "bedroom"
        return types

    def floor_lut(self, types):
        lut = np.zeros((len(types) + 1, 3), np.uint8)
        for k, t in enumerate(types):
            lut[k] = FLOOR_RGB[FLOOR_OF.get(t, "wood")]
        lut[len(types)] = FLOOR_RGB["wood"]
        return lut

    def floor_pattern(self, rr, cc, types, rid):
        """brightness per cell: tile checker / plank stripes, quantised."""
        k = max(1, int(round(0.45 / self.vs)))
        kind = np.array([FLOOR_OF.get(t, "wood") for t in types] + ["wood"])
        rk = kind[np.where(rid[rr, cc] >= 0, rid[rr, cc], len(types))]
        chk = (((self.x0 + cc) // k + (self.z0 + rr) // k) % 2 == 0)
        pl = (((self.z0 + rr) // max(1, int(round(0.15 / self.vs)))) % 2 == 0)
        f = np.ones(len(rr))
        tile = (rk == "tile") | (rk == "stone")
        f = np.where(tile & ~chk, 0.94, f)
        f = np.where((rk == "wood") & ~pl, 0.95, f)
        return f

    # -- fixtures
    def fixtures(self, pp, g, rooms, types, L, rid, zone):
        vs = self.vs
        out = []
        doors = g["doors"]
        lo, hi = self.fy[L] + 1, self.top_rows[L]
        wz = unary_union(self.zone_polys_uv(lo, hi, 0.25)) if self.zones else None
        dz = []
        for d in doors:
            c, dd = d["c"], d["d"]
            nrm = (-dd[1], dd[0])
            ex, ey = abs(dd[0]) * (DOOR_W / 2 + 0.3) + abs(nrm[0]) * 1.0, abs(dd[1]) * (DOOR_W / 2 + 0.3) + abs(nrm[1]) * 1.0
            dz.append(sbox(c[0] - ex, c[1] - ey, c[0] + ex, c[1] + ey))
        ent = pp["ent_in"]
        if L == 0:
            dz.append(sbox(ent[0] - 0.8, ent[1] - 0.8, ent[0] + 0.8, ent[1] + 0.8))
        for sp in pp["specs"]:
            dz.append(sbox(*sp["body"]).buffer(0.1))
            dz += [sbox(*a) for a in sp["aprons"]]
        if pp["lift"] is not None:
            dz.append(pp["lift"].buffer(0.1))
        blk = list(dz) + (list(_polys(wz)) if wz is not None and not wz.is_empty else [])
        blk_tree = shapely.STRtree(blk) if blk else None
        for k, r in enumerate(rooms):
            self.check()
            t = types[k]
            if r["circ"] or t in ("lift", "stairs"):
                continue
            free = r["poly"].buffer(-(0.12 + self.hw_part))
            if free.is_empty:
                continue
            keys = self._door_keys(r["poly"], k, doors)
            obst: List[Polygon] = []
            if blk_tree is not None:
                near = sorted(int(i) for i in blk_tree.query(r["poly"].buffer(0.5)))
                blocked = unary_union([blk[i] for i in near]) if near else Polygon()
            else:
                blocked = Polygon()

            def put(name, mode, tall=False):
                nonlocal blocked
                self.check()
                pr = _prop(name, vs, self.C)
                if pr is None:
                    return None
                a, b, parts = pr
                if max(a, b) < 0.15:
                    return None
                res = self._place(free, blocked, a, b, mode, keys, obst)
                if res is None:
                    return None
                side, ox, oy = res
                boxes, fp = _orient_parts(parts, a, b, side, ox, oy)
                blocked = unary_union([blocked, sbox(*fp).buffer(0.3)])
                obst.append(sbox(*fp))
                for (u0, v0, u1, v1, h0, h1, col) in boxes:
                    out.append(self.fix_box(u0, v0, u1, v1, h0, h1, col, L, zone))
                return fp
            area = r["poly"].area
            if t == "bedroom":
                put("bed", "wall"); put("wardrobe", "wall")
                if area > 13:
                    fp = put("desk", "wall")
                    if fp:
                        put("chair", "centre")
            elif t == "living":
                put("sofa", "wall"); put("coffee", "centre")
                if area > 16:
                    put("table", "centre")
                    for _ in range(4):
                        put("chair", "centre")
            elif t == "dining":
                put("table", "centre")
                for _ in range(4):
                    put("chair", "centre")
            elif t == "kitchen":
                put("kitchen", "wall")
                if area > 9:
                    put("table", "centre"); put("chair", "centre"); put("chair", "centre")
            elif t == "study":
                put("desk", "wall"); put("chair", "centre"); put("wardrobe", "wall")
            elif t in ("bath", "wc"):
                put("wc", "wall"); put("basin", "wall")
                if t == "bath" and area >= 5:
                    put("bath", "wall")
            elif t == "office":
                put("desk", "wall"); put("chair", "centre")
                if area > 14:
                    put("desk", "wall"); put("chair", "centre")
            elif t == "meeting":
                put("table", "centre")
                for _ in range(6):
                    put("chair", "centre")
            elif t == "shop":
                put("counter", "wall")
                for _ in range(max(0, min(8, int(area / 22)))):
                    put("rack", "wall")
                self.columns(r["poly"], blocked, out, L, zone, spacing=6.0)
            elif t == "industrial":
                for _ in range(max(0, min(30, int(area / 30)))):
                    put("crate", "wall")
                self.columns(r["poly"], blocked, out, L, zone, spacing=6.0)
            elif t == "nave":
                self.nave(r["poly"], blocked, out, L, zone, put)
        return out

    def _door_keys(self, poly, k, doors):
        """points just inside room k in front of each of its doors (fixtures must not separate them)."""
        keys = []
        for d in doors:
            if k in (d["a"], d["b"]):
                c, dd = d["c"], d["d"]
                for sg in (1.0, -1.0):
                    p = (c[0] - dd[1] * 0.5 * sg, c[1] + dd[0] * 0.5 * sg)
                    if poly.buffer(0.01).contains(Point(p)):
                        keys.append(p)
                        break
        return keys

    def _separates(self, free, obst, keys) -> int:
        """number of walkable components (passages >= 0.6 m wide, props keep 0.3 m clearance) that hold the keys;
        a large number if a key is walled in."""
        walk = free.difference(unary_union([o.buffer(0.3) for o in obst])) if obst else free
        walk = walk.buffer(-0.3, join_style=2, mitre_limit=2.0)       # passages >= 0.6 m: the client is a 0.6 m disc
        comps = _polys(walk)
        ids = set()
        for p in keys:
            pt = Point(p)
            hit = [i for i, c in enumerate(comps) if c.distance(pt) <= 0.3]
            if not hit:
                return 99
            ids.add(hit[0])
        return len(ids)

    @_guard(lambda self,*a,**k: None)
    def _place(self, free: Polygon, blocked, a, b, mode, keys=None, obst=None):
        """Pick a footprint for an a x b prop inside `free`, clear of `blocked`; -> (side, ox, oy) or None.
        With several door `keys` a placement must not cut the room into separate parts."""
        self.check()
        u0, v0, u1, v1 = free.bounds
        S, OX, OY = [], [], []
        if mode == "wall":
            for side in range(4):
                if side in (0, 2):
                    xs = np.arange(u0, u1 - a + 1e-9, 0.4)
                    OX.append(xs); OY.append(np.full(len(xs), v0 if side == 0 else v1 - b))
                else:
                    ys = np.arange(v0, v1 - a + 1e-9, 0.4)
                    OX.append(np.full(len(ys), u0 if side == 3 else u1 - b)); OY.append(ys)
                S.append(np.full(len(OX[-1]), side))
        else:
            cu, cv = free.centroid.x, free.centroid.y
            d = np.arange(-3.0, 3.01, 0.4)
            gx, gy = np.meshgrid(d, d)
            for side in (0, 3):
                A, B = (a, b) if side == 0 else (b, a)
                OX.append(cu - A / 2 + gx.ravel()); OY.append(cv - B / 2 + gy.ravel())
                S.append(np.full(gx.size, side))
        S, OX, OY = np.concatenate(S), np.concatenate(OX), np.concatenate(OY)
        if len(S) == 0:
            return None
        order = self.rng.permutation(len(S))[:200]
        S, OX, OY = S[order], OX[order], OY[order]
        w = np.where((S == 0) | (S == 2), a, b)
        h = np.where((S == 0) | (S == 2), b, a)
        boxes = shapely.box(OX, OY, OX + w, OY + h)
        ok = shapely.contains(free, boxes)
        if blocked is not None and not blocked.is_empty:
            ok &= ~shapely.intersects(blocked, boxes)
        idx = np.nonzero(ok)[0]
        if len(idx) == 0:
            return None
        if keys is None or len(keys) < 2:
            k = int(idx[0])
            return int(S[k]), float(OX[k]), float(OY[k])
        base = self._separates(free, obst or [], keys)
        for k in idx[:12]:
            fp = sbox(float(OX[k]), float(OY[k]), float(OX[k] + w[k]), float(OY[k] + h[k]))
            if self._separates(free, (obst or []) + [fp], keys) <= base:
                return int(S[k]), float(OX[k]), float(OY[k])
        return None

    def fix_box(self, u0, v0, u1, v1, h0, h1, col, L, zone):
        vs = self.vs
        if u1 - u0 < 0.5 * vs - 1e-9 and v1 - v0 < 0.5 * vs - 1e-9:
            pass
        rr, cc = self.urect(u0, v0, u1, v1)
        if len(rr) == 0:   # sub-voxel part: take the cell under its centre
            rr, cc = self.urect((u0 + u1) / 2 - vs / 2, (v0 + v1) / 2 - vs / 2, (u0 + u1) / 2 + vs / 2, (v0 + v1) / 2 + vs / 2)
            if len(rr) > 1:
                rr, cc = rr[:1], cc[:1]
        m = self.free[rr, cc] & ~zone[rr, cc]
        rr, cc = rr[m], cc[m]
        r0 = int(round(h0 / vs))
        r1 = max(r0 + 1, int(round(h1 / vs)))
        y0 = self.fy[L] + 1 + r0
        y1 = min(self.top_rows[L] + 1, self.fy[L] + 1 + r1)
        return self.vox(rr, cc, y0, y1, np.tile(_rgb(col), (len(rr), 1)), MO)

    @_guard(lambda self,*a,**k: None)
    def columns(self, poly, blocked, out, L, zone, spacing):
        u0, v0, u1, v1 = poly.bounds
        if min(u1 - u0, v1 - v0) < 9.0:
            return
        inner = poly.buffer(-0.5)
        shapely.prepare(inner)
        nu = max(1, int(round((u1 - u0) / spacing)))
        nv = max(1, int(round((v1 - v0) / spacing)))
        for i in range(1, nu):
            self.check()
            for j in range(1, nv):
                u = u0 + (u1 - u0) * i / nu
                v = v0 + (v1 - v0) * j / nv
                b = sbox(u - 0.15, v - 0.15, u + 0.15, v + 0.15)
                if inner.contains(b) and not blocked.intersects(b):
                    out.append(self.fix_box(u - 0.15, v - 0.15, u + 0.15, v + 0.15, 0.0, 99.0, C_SLAB, L, zone))

    def nave(self, poly, blocked, out, L, zone, put):
        u0, v0, u1, v1 = poly.bounds
        W = v1 - v0
        if W < 5 or (u1 - u0) < 8:
            return
        vm = 0.5 * (v0 + v1)
        ais = max(1.6, W * 0.18)
        inner = poly.buffer(-0.5)
        shapely.prepare(inner)
        pews_ok = poly.buffer(-0.4)
        shapely.prepare(pews_ok)
        u = u0 + 2.0
        while u < u1 - 4.0:
            self.check()
            for v in (vm - W / 2 + ais + 1.2, vm + W / 2 - ais - 1.2):
                b = sbox(u - 0.2, v - 0.2, u + 0.2, v + 0.2)
                if inner.contains(b) and not blocked.intersects(b):
                    out.append(self.fix_box(u - 0.2, v - 0.2, u + 0.2, v + 0.2, 0.0, 99.0, C_SLAB, L, zone))
            u += 4.0
        # pews: rows either side of the central aisle
        a, b, parts = _prop("pew", self.vs, self.C)
        u = u0 + 2.5
        while u + b < u1 - 5.0:
            self.check()
            for vs0 in (vm - 0.7 - a * 1.0 - 0.2, vm + 0.7 + 0.2):
                fp = sbox(u, vs0, u + b, vs0 + a)
                if pews_ok.contains(fp) and not blocked.intersects(fp):
                    boxes, _ = _orient_parts(parts, a, b, 3, u, vs0)
                    for (bu0, bv0, bu1, bv1, h0, h1, col) in boxes:
                        out.append(self.fix_box(bu0, bv0, bu1, bv1, h0, h1, col, L, zone))
            u += 1.5
        # altar at the far end
        a, b, parts = _prop("altar", self.vs, self.C)
        fp = sbox(u1 - 0.5 - b, vm - a / 2, u1 - 0.5, vm + a / 2)
        if poly.buffer(-0.3).contains(fp):
            boxes, _ = _orient_parts(parts, a, b, 1, u1 - 0.5 - b, vm - a / 2)
            for (bu0, bv0, bu1, bv1, h0, h1, col) in boxes:
                out.append(self.fix_box(bu0, bv0, bu1, bv1, h0, h1, col, L, zone))

    def paint_shell(self):
        out = []
        base, eave = self.bd.base_y, int(self.bd.eave_y)
        # entrance door (painted) for parts whose entrance has no facade door
        self._painted_doors = 0
        for pp in self.parts_plan:
            pp["door_cells_all"] = []
            for ent in [pp["ent"]] + list(pp["exits"]):
                if not ent["paint"]:
                    continue
                cells = self.door_cells(ent)
                if cells is None:
                    continue
                rr, cc = cells
                ytop = min(eave - 1, base + self.door_rows)
                out.append(self.vox(rr, cc, base + 1, ytop + 1, np.tile(_rgb(C_DOOR), (len(rr), 1)), MW))
                pp["door_cells_all"].append((rr, cc))
                self._painted_doors += 1
        # extra inner layers (skip window/door boxes)
        if self.D > 1 and self.ring.any():
            for L in range(self.n_eff):
                lo = base + 1 if L == 0 else self.fy[L] - self.st + 1
                hi = self.top_rows[L] if L < self.n_eff - 1 else eave - 1
                if L == 0:
                    lo = base + 1
                z = self.zone_mask(lo, hi)
                m = self.ring & ~z
                for pp in self.parts_plan:
                    for dc in pp.get("door_cells_all", []):
                        m[dc[0], dc[1]] = False
                rr, cc = np.nonzero(m)
                out.append(self.vox(rr, cc, lo, hi + 1, np.tile(_rgb(C_PLASTER), (len(rr), 1)), MW))
        return out

    def door_cells(self, ent):
        t = np.asarray(ent["tan"]); n = np.asarray(ent["n_in"]); p0 = np.asarray(ent["pt_b"])
        L = DOOR_W / 2 + 0.5 * self.vs
        reach = (self.D + 1) * self.vs
        pts = [p0 + t * s + n * d for s in (-L, L) for d in (-reach, reach)]
        E = np.array([p[0] for p in pts]); N = np.array([p[1] for p in pts])
        c0 = max(0, int(math.floor((E.min() - self.grid.e0) / self.vs)) - self.x0 - 1)
        c1 = min(self.w, int(math.ceil((E.max() - self.grid.e0) / self.vs)) - self.x0 + 1)
        r0 = max(0, int(math.floor((self.grid.n0 - N.max()) / self.vs)) - self.z0 - 1)
        r1 = min(self.h, int(math.ceil((self.grid.n0 - N.min()) / self.vs)) - self.z0 + 1)
        if c1 <= c0 or r1 <= r0:
            return None
        Eg = self.cell_E(np.arange(c0, c1))[None, :]
        Ng = self.cell_N(np.arange(r0, r1))[:, None]
        al = (Eg - p0[0]) * t[0] + (Ng - p0[1]) * t[1]
        de = (Eg - p0[0]) * n[0] + (Ng - p0[1]) * n[1]
        m = (np.abs(al) <= L) & (de >= -0.5 * self.vs) & (de < self.D * self.vs + 0.5 * self.vs)
        sub = self.F[r0:r1, c0:c1]
        m &= sub
        rr, cc = np.nonzero(m)
        if len(rr) == 0:
            return None
        return rr + r0, cc + c0


def doorway_mask(X, Y, Z, ent: dict, grid, avoid=None) -> np.ndarray:
    """bool mask of the voxels (grid indices X, Y, Z) that fill the doorway of one ``entrances_raw`` record: the lane
    ``widthM`` wide along the door line from the outside point to the inside point, from the feet row up to 2.0 m.
    Removing them leaves a walkable opening (floor / ground untouched, wall above 2.0 m stays as the lintel).
    ``avoid``: geometry (UTM) of other parts / neighbours whose voxels must not be removed."""
    vs = grid.vs
    y0 = int(round(ent["inside"][1] / vs))
    hr = int(math.ceil(2.0 / vs - 1e-9))
    X, Y, Z = np.asarray(X), np.asarray(Y), np.asarray(Z)
    m = (Y >= y0) & (Y < y0 + hr)
    E = grid.e0 + (X + 0.5) * vs - ent["pt"][0]
    N = grid.n0 - (Z + 0.5) * vs - ent["pt"][1]
    al = E * ent["tan"][0] + N * ent["tan"][1]
    de = E * ent["n_in"][0] + N * ent["n_in"][1]
    h = 0.5 * ent["widthM"] + 0.5 * vs
    m &= (np.abs(al) <= h) & (de >= -ent["dOut"] - 0.5 * vs - DOOR_APPROACH) & (de <= ent["dIn"] + 0.5 * vs)
    if avoid is not None and m.any():       # voxels inside the footprint of another part / neighbour stay
        idx = np.nonzero(m)[0]
        inside = shapely.contains_xy(avoid, E[idx] + ent["pt"][0], N[idx] + ent["pt"][1])
        m[idx[inside]] = False
    return m


def stair_lane_w(vs: float) -> float:
    """Stair lane width (m): >= 1.0 m, and wide enough that after the 1-cell wall on each side the free lane still
    holds a 0.6 m body with a cell of slack at any voxel size (0.6 + 3 cells)."""
    return round(max(STAIR_W, 0.6 + 3.0 * vs), 2)


def min_storey_rows(vs: float) -> int:
    """Smallest storey height (rows) the interior builds: slab + 1.9 m clear, never below 2.1 m, and (multi-storey
    buildings have stairs whose flights stack one storey apart) STAIR_HEAD of vertical head room above every tread
    plus one 1-row thin tread and one row of rounding slack, i.e. about 2.7 m."""
    st = max(1, int(round(SLAB_T / vs)))
    stair = int(math.ceil(STAIR_HEAD / vs - 1e-9)) + 2
    return max(st + max(4, int(round(1.9 / vs))), int(math.floor(2.1 / vs + 1e-9)), stair)


def _principal_angle(poly) -> float:
    """Direction (degrees, in (-90, 90]) of the long side of the minimum-area rotated rectangle of the hull;
    within 4 degrees of a grid axis it snaps to that axis so partitions rasterise cleanly."""
    try:
        h = np.asarray(poly.convex_hull.exterior.coords)
        d = np.diff(h, axis=0)
        L = np.hypot(d[:, 0], d[:, 1])
        ok = L > 1e-6
        if not ok.any():
            return 0.0
        th = np.arctan2(d[ok, 1], d[ok, 0])
        best = None
        for t in th:
            c, s = math.cos(t), math.sin(t)
            u = h[:, 0] * c + h[:, 1] * s
            v = -h[:, 0] * s + h[:, 1] * c
            w, hh = float(u.max() - u.min()), float(v.max() - v.min())
            key = (round(w * hh, 6), round(float(t), 9))
            if best is None or key < best[0]:
                best = (key, math.degrees(t) if w >= hh else math.degrees(t) + 90.0)
        ang = ((best[1] + 90.0) % 180.0) - 90.0
        if ang == -90.0:
            ang = 90.0
        r = ang - 90.0 * round(ang / 90.0)
        if abs(r) < 4.0:
            ang = 90.0 * round(ang / 90.0)
        return float(ang)
    except Exception:
        return 0.0


def _clean(g):
    """valid geometry with coordinates snapped to 1 cm (kills the 1e-16 slivers that union/difference leave behind
    and that would otherwise be detected as shared walls)."""
    if g is None or g.is_empty:
        return g
    g = g.buffer(0)
    try:
        g2 = shapely.set_precision(g, 1e-2)
        if not g2.is_empty and g2.is_valid:
            g = g2
    except _GEOS_ERR:
        pass
    if g.is_empty:
        return g
    if g.geom_type == "MultiPolygon":
        ps = sorted(_polys(g), key=lambda p: -p.area)
        return ps[0] if len(ps) == 1 else MultiPolygon(ps)
    return g


def build_interior(building, opts: dict, grid_spec, rng: np.random.Generator) -> Tuple[np.ndarray, np.ndarray]:
    """Generate the interior voxels of ``building`` (see module docstring for the contract).

    Returns (xyz int32 (N,3), codes uint32 (N,)); codes use ``ground.pack`` (rgb << 3 | material index, materials
    from ``tiles.MATS``: 2 = wall, 4 = other is used here for floors/fixtures, deliberately no new material)."""
    b = _Builder(building, opts or {}, grid_spec, rng)
    out = b.run()
    return out
