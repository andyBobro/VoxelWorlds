"""Roof shapes: tag parsing, inference, and per-cell roof height fields.

No straight-skeleton library is used (no portable binary wheels): heights come from closed-form fields on the
oriented minimum rotated rectangle (gabled / skillion / pyramidal / dome / round) and from the distance to the
footprint boundary (hipped / mansard), which equals the straight skeleton height on rectangles and degrades
gracefully on irregular outlines. Everything is a pure function of the footprint and the tags, so the result is
identical in every tile that voxelizes the building."""
from __future__ import annotations

import math
import re
import warnings
import zlib
from dataclasses import dataclass
from typing import Optional

import numpy as np
import shapely
from shapely.geometry import Polygon

from ..config import Config

SHAPES = ("flat", "gabled", "hipped", "pyramidal", "skillion", "dome", "round", "mansard", "cone")

_ALIAS = {
    "flat": "flat", "no": "flat", "none": "flat", "sawtooth": "flat", "butterfly": "flat",
    "gabled": "gabled", "gable": "gabled", "pitched": "gabled", "saltbox": "gabled", "gambrel": "gabled",
    "gabled_height_hipped": "gabled", "double_saltbox": "gabled", "bohemian": "hipped",
    "hipped": "hipped", "hip": "hipped", "half_hipped": "hipped", "half_hip": "hipped",
    "side_hipped": "hipped", "side_half_hipped": "hipped", "hipped_and_gabled": "hipped",
    "pyramidal": "pyramidal", "pyramid": "pyramidal", "cone": "cone", "conical": "cone",
    "skillion": "skillion", "lean_to": "skillion", "mono_pitched": "skillion", "shed": "skillion",
    "dome": "dome", "onion": "dome", "round": "round", "barrel": "round", "arch": "round",
    "mansard": "mansard", "mansard_roof": "mansard",
}
_CARD = {"n": 0, "nne": 22.5, "ne": 45, "ene": 67.5, "e": 90, "ese": 112.5, "se": 135, "sse": 157.5,
         "s": 180, "ssw": 202.5, "sw": 225, "wsw": 247.5, "w": 270, "wnw": 292.5, "nw": 315, "nnw": 337.5}
_NUM = re.compile(r"[-+]?\d+(?:[.,]\d+)?")

_PITCHED_TYPES_GABLE = {"house", "detached", "semidetached_house", "terrace", "residential", "farm",
                        "bungalow", "villa", "cabin", "farm_auxiliary", "barn", "stable", "cowshed",
                        "static_caravan", "house_boat"}
_FLAT_TYPES = {"industrial", "commercial", "retail", "warehouse", "garage", "garages", "shed", "carport",
               "supermarket", "office", "factory", "hangar", "greenhouse", "kiosk", "parking",
               "service", "roof", "hospital", "university", "train_station", "hotel", "storage_tank"}
_NARROW_TYPES = {"yes", "building", "apartments", "residential", "commercial", "retail", "hotel", "office",
                 "dormitory", "terrace", "house", "public", "civic", "government", "school"}
_CHURCH = {"church", "cathedral", "chapel", "monastery", "temple"}


def normalize_shape(s: Optional[str]) -> Optional[str]:
    """roof:shape tag -> one of SHAPES, or None when absent / unknown."""
    if not s:
        return None
    v = s.split(";")[0].strip().lower().replace("-", "_").replace(" ", "_")
    return _ALIAS.get(v)


def parse_bearing(s: Optional[str]) -> Optional[float]:
    """roof:direction: degrees clockwise from north or a cardinal abbreviation."""
    if not s:
        return None
    v = s.strip().lower()
    if v in _CARD:
        return float(_CARD[v])
    m = _NUM.search(v)
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ".")) % 360.0
    except ValueError:
        return None


def _h(key: str, seed: int, salt: int = 0) -> float:
    """Deterministic uniform [0,1) from the building id."""
    return (zlib.crc32(f"{key}:{seed}:{salt}".encode("utf-8")) & 0xFFFF) / 65536.0


def infer_shape(key: str, btype: Optional[str], area: float, height_m: float, cfg: Config,
                depth_m: Optional[float] = None) -> str:
    """Deterministic guess when roof:shape is missing (toggle: cfg.infer_roof_shapes)."""
    t = (btype or "yes").lower()
    lim = cfg.infer_max_height_m + (8.0 if t in ("apartments", "dormitory") else 0.0)
    if not cfg.infer_roof_shapes or height_m > lim:
        return "flat"
    u = _h(key, cfg.seed)
    if t in _CHURCH:
        return "pyramidal" if area < 100.0 else "gabled"
    if t in _PITCHED_TYPES_GABLE:
        return "hipped" if u < 0.35 else "gabled"
    if t in _FLAT_TYPES:
        return "flat"
    if t in ("apartments", "dormitory", "semidetached"):
        return ("hipped" if u < 0.2 else "gabled") if u < 0.6 else "flat"
    if t in ("yes", "building") and 40.0 <= area <= 250.0 and height_m <= 10.0:
        return "gabled" if u < 0.6 else ("hipped" if u < 0.8 else "flat")
    # narrow city lots (terraced old-town / street-block buildings): mostly pitched in practice
    if (depth_m is not None and depth_m <= cfg.infer_narrow_depth_m and area <= 600.0
            and t in _NARROW_TYPES and _h(key, cfg.seed, 5) < cfg.infer_narrow_pitched_prob):
        return "hipped" if u < 0.18 else "gabled"
    return "flat"


@dataclass
class RoofSpec:
    shape: str = "flat"
    height_m: float = 0.0
    # oriented minimum rotated rectangle: centre, long-axis unit vector, half extents
    cx: float = 0.0
    cy: float = 0.0
    ux: float = 1.0
    uy: float = 0.0
    hl: float = 1.0
    hw: float = 1.0
    # slope axis (unit, E/N) and polygon extent along it
    sx: float = 0.0
    sy: float = 1.0
    tmin: float = -1.0
    tmax: float = 1.0


def frame_of(poly: Polygon):
    """(cx, cy, ux, uy, hl, hw) of the minimum rotated rectangle; long axis first."""
    try:
        with warnings.catch_warnings():  # GEOS float-flag noise on exact rectangles
            warnings.simplefilter("ignore")
            mrr = shapely.minimum_rotated_rectangle(poly)
        co = np.asarray(mrr.exterior.coords)[:4]
        e1, e2 = co[1] - co[0], co[2] - co[1]
        l1, l2 = float(np.hypot(*e1)), float(np.hypot(*e2))
        if l1 < 1e-6 or l2 < 1e-6:
            raise ValueError("degenerate")
        if l1 < l2:
            e1, l1, l2 = e2, l2, l1
        u = e1 / l1
        c = co.mean(0)
        return float(c[0]), float(c[1]), float(u[0]), float(u[1]), l1 / 2.0, l2 / 2.0
    except Exception:
        minx, miny, maxx, maxy = poly.bounds
        return ((minx + maxx) / 2, (miny + maxy) / 2, 1.0, 0.0, max(0.5, (maxx - minx) / 2),
                max(0.5, (maxy - miny) / 2))


def plan_roof(key: str, poly: Polygon, shape: str, height_tag: Optional[float], levels_tag: Optional[float],
              direction: Optional[float], orientation: Optional[str], mpf: float, cap_m: float,
              cfg: Config) -> RoofSpec:
    """Resolve the final RoofSpec. ``cap_m`` is the largest roof height allowed by the caller
    (already combines roof_max_height_m / roof_max_frac / available building height)."""
    spec = RoofSpec(shape=shape)
    if shape == "flat":
        return spec
    cx, cy, ux, uy, hl, hw = frame_of(poly)
    spec.cx, spec.cy, spec.ux, spec.uy, spec.hl, spec.hw = cx, cy, ux, uy, hl, hw
    ori = (orientation or "").strip().lower()
    if direction is not None:
        a = math.radians(direction)
        sx, sy = math.sin(a), math.cos(a)  # slope (down-hill) direction, E/N
    elif ori == "across":
        sx, sy = ux, uy
    else:  # ridge along the long axis -> slope across it
        sx, sy = -uy, ux
        if shape == "skillion":  # choose the downhill side deterministically
            if _h(key, cfg.seed, 7) < 0.5:
                sx, sy = -sx, -sy
    spec.sx, spec.sy = sx, sy
    co = np.asarray(poly.exterior.coords)
    t = (co[:, 0] - cx) * sx + (co[:, 1] - cy) * sy
    spec.tmin, spec.tmax = float(t.min()), float(t.max())
    half_w = max(0.25, (spec.tmax - spec.tmin) / 2.0)
    if height_tag is not None and height_tag > 0:
        rh = height_tag
    elif levels_tag is not None and levels_tag > 0:
        rh = levels_tag * mpf
    else:
        tp = math.tan(math.radians(cfg.roof_pitch_deg))
        if shape == "gabled":
            rh = tp * half_w
        elif shape in ("hipped", "pyramidal", "cone"):
            rh = tp * hw
        elif shape == "skillion":
            rh = math.tan(math.radians(cfg.skillion_pitch_deg)) * (spec.tmax - spec.tmin)
        elif shape == "mansard":
            rh = min(cfg.mansard_height_m, tp * hw * 1.4)
        elif shape == "dome":
            rh = 0.8 * min(hw, hl)
        else:  # round
            rh = 0.8 * half_w
    if shape in ("gabled", "hipped", "pyramidal", "cone"):  # never steeper than ~62 degrees
        rh = min(rh, math.tan(math.radians(62.0)) * (half_w if shape == "gabled" else hw))
    spec.height_m = float(max(0.0, min(rh, cap_m)))
    if spec.height_m <= 0.0:
        spec.shape = "flat"
    return spec


def _boundary_dist(poly: Polygon, ce: np.ndarray, cn: np.ndarray) -> np.ndarray:
    return shapely.distance(poly.boundary, shapely.points(ce, cn))


def roof_heights(spec: RoofSpec, poly: Polygon, ce: np.ndarray, cn: np.ndarray) -> np.ndarray:
    """Roof surface height (metres above the eave) at the given cell centres (UTM E/N)."""
    n = len(ce)
    if spec.shape == "flat" or spec.height_m <= 0 or n == 0:
        return np.zeros(n)
    rh = spec.height_m
    dx, dy = ce - spec.cx, cn - spec.cy
    sh = spec.shape
    if sh in ("gabled", "round"):
        t = dx * spec.sx + dy * spec.sy
        tm = (spec.tmin + spec.tmax) / 2.0 - 0.0
        W = max(1e-6, (spec.tmax - spec.tmin) / 2.0)
        q = np.abs(t - tm) / W
        if sh == "gabled":
            return rh * np.clip(1.0 - q, 0.0, 1.0)
        return rh * np.sqrt(np.clip(1.0 - q * q, 0.0, 1.0))
    if sh == "skillion":
        t = dx * spec.sx + dy * spec.sy
        return rh * np.clip((spec.tmax - t) / max(1e-6, spec.tmax - spec.tmin), 0.0, 1.0)
    if sh in ("pyramidal", "dome", "cone"):
        a = np.abs(dx * spec.ux + dy * spec.uy) / max(1e-6, spec.hl)
        b = np.abs(-dx * spec.uy + dy * spec.ux) / max(1e-6, spec.hw)
        if sh == "pyramidal":
            return rh * np.clip(1.0 - np.maximum(a, b), 0.0, 1.0)
        rho = np.hypot(a, b)
        if sh == "cone":
            return rh * np.clip(1.0 - rho, 0.0, 1.0)
        return rh * np.sqrt(np.clip(1.0 - rho * rho, 0.0, 1.0))
    # hipped / mansard: distance to the footprint boundary
    d = _boundary_dist(poly, ce, cn)
    if sh == "mansard":
        return np.minimum(rh, d * math.tan(math.radians(68.0)))
    dmax = float(d.max())
    if dmax <= 1e-6:
        return np.zeros(n)
    return rh * np.minimum(1.0, d / dmax)
