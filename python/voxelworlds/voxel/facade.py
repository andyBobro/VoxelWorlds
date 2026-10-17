"""Procedural, deterministic facade/roof colours from building tags."""
from __future__ import annotations

import zlib
from typing import Optional, Tuple

import numpy as np

from . import colours

RGB = Tuple[int, int, int]

KINDS = {
    "residential": {"residential", "house", "detached", "semidetached_house", "terrace", "apartments",
                    "dormitory", "bungalow", "villa", "farm", "houseboat"},
    "commercial": {"commercial", "retail", "office", "shop", "supermarket", "hotel", "kiosk", "mall",
                   "restaurant", "cafe", "bank"},
    "industrial": {"industrial", "warehouse", "factory", "manufacture", "storage_tank", "hangar"},
    "religious": {"church", "cathedral", "chapel", "mosque", "synagogue", "temple", "religious",
                  "monastery"},
    "civic": {"public", "civic", "government", "school", "university", "hospital", "college",
              "train_station", "townhall", "museum", "kindergarten", "library", "theatre"},
    "minor": {"garage", "garages", "shed", "carport", "roof", "hut", "cabin", "service", "greenhouse"},
}
WALLS = {
    "residential": [(226, 208, 176), (200, 120, 92), (236, 228, 210), (190, 170, 140), (214, 180, 150)],
    "commercial": [(176, 182, 190), (210, 210, 205), (150, 160, 170), (196, 176, 150)],
    "industrial": [(150, 150, 148), (130, 138, 142), (170, 164, 150)],
    "religious": [(220, 214, 200), (196, 188, 170), (232, 226, 214)],
    "civic": [(190, 150, 120), (214, 200, 170), (180, 176, 170)],
    "minor": [(160, 150, 140), (140, 140, 138), (176, 160, 130)],
    "generic": [(205, 195, 180), (190, 180, 170), (215, 205, 190), (180, 170, 160)],
}
def building_kind(tags: dict) -> str:
    cands = [tags.get("building"), tags.get("amenity"), tags.get("shop"), tags.get("office"),
             tags.get("tourism"), tags.get("building:use")]
    for c in cands:
        if not c:
            continue
        c = str(c).lower()
        for k, vals in KINDS.items():
            if c in vals:
                return k
    return "generic"


def seed_for(key: str, base_seed: int) -> int:
    return (zlib.crc32(key.encode("utf-8")) ^ (base_seed * 2654435761)) & 0xFFFFFFFF


parse_colour = colours.parse_colour


ROOF_DEFAULTS = {
    "tiles": [(176, 88, 62), (164, 80, 58), (188, 102, 72), (150, 74, 54)],
    "slate": [(76, 82, 94), (64, 70, 82), (88, 94, 104)],
    "brown": [(110, 84, 72), (124, 96, 80)],
    "tar": [(62, 62, 66), (74, 74, 76), (88, 88, 90)],
    "gravel": [(138, 134, 126), (120, 118, 112)],
    "copper": [(104, 156, 136), (96, 146, 128)],
    "metal": [(140, 148, 156), (126, 134, 142)],
}
# per shape class: [(palette, weight)] ; kind-specific overrides below
_PITCHED_MIX = [("tiles", 0.55), ("slate", 0.30), ("brown", 0.15)]


def _pick_mix(rng, mix):
    u = float(rng.random())
    acc = 0.0
    for name, w in mix:
        acc += w
        if u < acc:
            return name
    return mix[-1][0]


def default_roof_colour(rng, kind: str, shape: str) -> RGB:
    """Procedural roof colour per roof shape (used only when no roof:colour / roof:material tag exists)."""
    if shape == "flat":
        name = _pick_mix(rng, [("tar", 0.6), ("gravel", 0.25), ("slate", 0.15)])
    elif shape in ("dome", "cone"):
        name = _pick_mix(rng, [("copper", 0.5), ("slate", 0.5)])
    elif shape == "skillion":
        name = _pick_mix(rng, [("metal", 0.5), ("tar", 0.2), ("tiles", 0.3)])
    elif shape == "mansard":
        name = _pick_mix(rng, [("slate", 0.7), ("copper", 0.3)])
    elif kind in ("religious", "civic"):
        name = _pick_mix(rng, [("slate", 0.55), ("copper", 0.25), ("tiles", 0.2)])
    elif kind in ("industrial", "commercial"):
        name = _pick_mix(rng, [("metal", 0.4), ("slate", 0.3), ("tiles", 0.3)])
    else:
        name = _pick_mix(rng, _PITCHED_MIX)
    pal = ROOF_DEFAULTS[name]
    return pal[int(rng.integers(len(pal)))]


def _jit(rgb: RGB, rng, amp: int) -> RGB:
    d = rng.integers(-amp, amp + 1, size=3)
    j = int(rng.integers(-amp, amp + 1))
    return tuple(int(np.clip(c + j + int(d[i]) // 3, 0, 255)) for i, c in enumerate(rgb))  # type: ignore


def building_colours(seed: int, kind: str, wall_tag: Optional[RGB], roof_tag: Optional[RGB],
                     roof_shape: str = "flat", wall_mat: Optional[str] = None,
                     roof_mat: Optional[str] = None):
    """(wall RGB, roof RGB). Priority: explicit colour tag > material tag > type/shape procedural default.
    Material / procedural colours get a small deterministic per-building variation; tag colours are exact."""
    rng = np.random.default_rng(seed)
    wk = rng.integers(len(WALLS[kind]))
    if wall_tag is not None:
        wall = tuple(int(c) for c in wall_tag)
    elif wall_mat and wall_mat in colours.WALL_MATERIALS:
        pal = colours.WALL_MATERIALS[wall_mat]
        wall = _jit(pal[int(rng.integers(len(pal)))], rng, 8)
    else:
        wall = _jit(WALLS[kind][int(wk)], rng, 10)
    if roof_tag is not None:
        roof = tuple(int(c) for c in roof_tag)
    elif roof_mat and roof_mat in colours.ROOF_MATERIALS:
        pal = colours.ROOF_MATERIALS[roof_mat]
        roof = _jit(pal[int(rng.integers(len(pal)))], rng, 6)
    else:
        roof = _jit(default_roof_colour(rng, kind, roof_shape), rng, 6)
    if roof_tag is None and wall_tag is None and roof == wall:
        roof = tuple(max(0, c - 40) for c in roof)
    return wall, roof


def wall_colours(x, y, z, base_y: int, vs: float, mpf: float, wall: RGB, window: RGB,
                 windows: bool = True) -> np.ndarray:
    """Per-voxel RGB with a window-row pattern."""
    n = len(x)
    out = np.empty((n, 3), np.uint8)
    out[:] = wall
    fl = max(1, int(round(mpf / vs)))
    if windows and fl >= 2 and n:
        local = (y - base_y - 1) % fl
        row = (local == fl // 2)
        if fl >= 4:
            row |= (local == fl // 2 - 1)
        floor_idx = (y - base_y - 1) // fl
        col = ((x + z) % 2 == 0)
        win = row & col & (floor_idx >= 0)
        out[win] = window
    return out
