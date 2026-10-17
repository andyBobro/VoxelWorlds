"""Sponge Schematic v2 (.schem) exporter with hand-rolled gzip NBT."""
from __future__ import annotations

import gzip
import struct
from typing import Dict, List, Tuple

import numpy as np

from ..voxel.vwg import read_vwg

DATA_VERSION = 3465  # Minecraft 1.20.1

_COLORS = {
    "white": (207, 213, 214), "orange": (224, 97, 0), "magenta": (169, 48, 159), "light_blue": (36, 137, 199),
    "yellow": (241, 175, 21), "lime": (94, 169, 24), "pink": (214, 101, 143), "gray": (55, 58, 62),
    "light_gray": (125, 125, 115), "cyan": (21, 119, 136), "purple": (100, 31, 156), "blue": (45, 47, 143),
    "brown": (96, 60, 32), "green": (73, 91, 36), "red": (142, 33, 33), "black": (8, 10, 15),
}
_TERRA = {
    "white": (209, 178, 161), "orange": (161, 83, 37), "magenta": (149, 88, 108), "light_blue": (113, 108, 137),
    "yellow": (186, 133, 35), "lime": (103, 117, 53), "pink": (161, 78, 78), "gray": (57, 42, 35),
    "light_gray": (135, 107, 98), "cyan": (87, 91, 91), "purple": (118, 70, 86), "blue": (74, 59, 91),
    "brown": (77, 51, 36), "green": (76, 83, 42), "red": (143, 61, 46), "black": (37, 22, 16),
}
GENERAL: List[Tuple[str, Tuple[int, int, int]]] = (
    [(f"{k}_concrete", v) for k, v in _COLORS.items()] +
    [(f"{k}_terracotta", v) for k, v in _TERRA.items()] +
    [("terracotta", (152, 94, 67)), ("stone", (125, 125, 125)), ("stone_bricks", (122, 121, 122)),
     ("bricks", (150, 97, 83)), ("sandstone", (216, 203, 155)), ("smooth_sandstone", (223, 214, 170)),
     ("andesite", (136, 136, 137)), ("polished_andesite", (132, 135, 134)), ("oak_planks", (162, 130, 78)),
     ("birch_planks", (192, 175, 121)), ("spruce_planks", (114, 84, 48)), ("quartz_block", (236, 230, 223)),
     ("smooth_stone", (158, 158, 158)), ("deepslate_tiles", (54, 54, 54)), ("white_wool", (233, 236, 236)),
     ("light_blue_stained_glass", (112, 169, 211)), ("gray_stained_glass", (76, 76, 76)),
     ("glass", (175, 213, 219)), ("nether_bricks", (44, 21, 26))]
)
ROAD = [("gray_concrete", _COLORS["gray"]), ("light_gray_concrete", _COLORS["light_gray"]),
        ("black_concrete", _COLORS["black"]), ("stone", (125, 125, 125)), ("andesite", (136, 136, 137)),
        ("dirt_path", (148, 122, 65)), ("smooth_stone", (158, 158, 158))]
GROUND = [("grass_block", (98, 134, 56)), ("dirt", (134, 96, 67)), ("sand", (219, 207, 163)),
          ("stone", (125, 125, 125)), ("andesite", (136, 136, 137)), ("light_gray_concrete", _COLORS["light_gray"]),
          ("gravel", (131, 127, 126)), ("coarse_dirt", (119, 85, 59))]
VEG = [("grass_block", (98, 134, 56)), ("moss_block", (89, 109, 45)), ("green_concrete", _COLORS["green"]),
       ("oak_leaves", (60, 112, 30))]
WATER = [("water", (52, 102, 160))]
SETS = {"road": ROAD, "ground": GROUND, "vegetation": VEG, "water": WATER}


def _nearest(rgb, cands) -> str:
    best, bd = cands[0][0], 1e18
    for name, (r, g, b) in cands:
        rm = (rgb[0] + r) / 2.0
        d = (2 + rm / 256) * (rgb[0] - r) ** 2 + 4 * (rgb[1] - g) ** 2 + (2 + (255 - rm) / 256) * (rgb[2] - b) ** 2
        if d < bd:
            best, bd = name, d
    return best


# ---- minimal NBT writer
def _s(v: str) -> bytes:
    b = v.encode("utf-8")
    return struct.pack(">H", len(b)) + b


def _named(tid: int, name: str, payload: bytes) -> bytes:
    return bytes([tid]) + _s(name) + payload


def _comp(items: List[bytes]) -> bytes:
    return b"".join(items) + b"\0"


def export_schem(input_path: str, output_path: str) -> None:
    header, x, y, z, c = read_vwg(input_path)
    if len(x) == 0:
        raise ValueError("no voxels to export")
    x0, y0, z0 = int(x.min()), int(y.min()), int(z.min())
    W, H, L = int(x.max()) - x0 + 1, int(y.max()) - y0 + 1, int(z.max()) - z0 + 1
    if W > 32767 or H > 32767 or L > 32767:
        raise ValueError("schematic dimension exceeds 32767")
    if W * H * L > 400_000_000:
        raise ValueError(f"schematic volume {W}x{H}x{L} too large for dense BlockData")
    pal = header["palette"]
    mats = header.get("materials") or ["other"] * len(pal)
    names: List[str] = []
    for i, rgb in enumerate(pal):
        names.append(_nearest(rgb, SETS.get(mats[i], GENERAL)) if i else "air")
    block_names = ["air"] + sorted(set(names[1:]) - {"air"})
    bidx = {n: i for i, n in enumerate(block_names)}
    lut = np.array([bidx[n] for n in names], np.uint16)
    grid = np.zeros(W * H * L, np.uint16)
    idx = ((y - y0).astype(np.int64) * L + (z - z0)) * W + (x - x0)
    grid[idx] = lut[c]
    data = _varints(grid)
    palette_nbt = _comp([_named(3, f"minecraft:{n}", struct.pack(">i", i)) for n, i in bidx.items()])
    root = _comp([
        _named(3, "Version", struct.pack(">i", 2)),
        _named(3, "DataVersion", struct.pack(">i", DATA_VERSION)),
        _named(2, "Width", struct.pack(">h", W)),
        _named(2, "Height", struct.pack(">h", H)),
        _named(2, "Length", struct.pack(">h", L)),
        _named(11, "Offset", struct.pack(">i", 3) + struct.pack(">3i", 0, 0, 0)),
        _named(3, "PaletteMax", struct.pack(">i", len(bidx))),
        _named(10, "Palette", palette_nbt),
        _named(7, "BlockData", struct.pack(">i", len(data)) + data),
        _named(10, "Metadata", _comp([_named(8, "Name", _s("VoxelWorlds")),
                                      _named(3, "WEOffsetX", struct.pack(">i", 0))])),
    ])
    with gzip.open(output_path, "wb") as f:
        f.write(_named(10, "Schematic", root))


def _varints(a: np.ndarray) -> bytes:
    """Encode uint16 array as VarInt bytes (values < 16384 mostly 1-2 bytes)."""
    small = a < 128
    if small.all():
        return a.astype(np.uint8).tobytes()
    out = np.empty((len(a), 2), np.uint8)
    out[:, 0] = (a & 0x7F) | np.where(small, 0, 0x80)
    out[:, 1] = a >> 7
    keep = np.stack([np.ones(len(a), bool), ~small], 1)
    return out[keep].tobytes()
