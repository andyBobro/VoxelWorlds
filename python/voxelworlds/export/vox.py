"""MagicaVoxel .vox (v150) exporter. MagicaVoxel is Z-up: X=east, Y=north, Z=up."""
from __future__ import annotations

import struct
from typing import Dict, List

import numpy as np

from ..voxel.vwg import read_vwg
from .quant import median_cut

TILE = 256


def _chunk(cid: bytes, content: bytes, children: bytes = b"") -> bytes:
    return cid + struct.pack("<ii", len(content), len(children)) + content + children


def _str(s: str) -> bytes:
    b = s.encode("ascii")
    return struct.pack("<i", len(b)) + b


def _dict(d: Dict[str, str]) -> bytes:
    out = struct.pack("<i", len(d))
    for k, v in d.items():
        out += _str(k) + _str(v)
    return out


def export_vox(input_path: str, output_path: str) -> None:
    header, x, y, z, c = read_vwg(input_path)
    pal = np.asarray(header["palette"], np.uint8)
    n = len(x)
    if n == 0:
        raise ValueError("no voxels to export")
    counts = np.bincount(c, minlength=len(pal)).astype(np.float64)
    used = np.nonzero(counts[1:])[0] + 1
    cents, mp = median_cut(pal[used], counts[used], 255)
    remap = np.zeros(len(pal), np.int64)
    remap[used] = mp + 1  # vox colour indices start at 1
    ci = remap[c].astype(np.uint8)

    # axes: vwg (x east, y up, z south) -> vox (X east, Y north, Z up)
    X = x - x.min()
    Y = z.max() - z
    Z = y - y.min()
    tiles = (X // TILE, Y // TILE, Z // TILE)
    tkey = (tiles[0].astype(np.int64) * 4096 + tiles[1]) * 4096 + tiles[2]
    order = np.argsort(tkey, kind="stable")
    tk = tkey[order]
    bounds = np.nonzero(np.diff(tk))[0] + 1
    groups = np.split(order, bounds)

    body = b""
    models: List[tuple] = []
    for g in groups:
        tx, ty, tz = int(tiles[0][g[0]]), int(tiles[1][g[0]]), int(tiles[2][g[0]])
        lx, ly, lz = X[g] - tx * TILE, Y[g] - ty * TILE, Z[g] - tz * TILE
        size = (int(lx.max()) + 1, int(ly.max()) + 1, int(lz.max()) + 1)
        xyzi = np.stack([lx, ly, lz, ci[g]], 1).astype(np.uint8).tobytes()
        body += _chunk(b"SIZE", struct.pack("<iii", *size))
        body += _chunk(b"XYZI", struct.pack("<i", len(g)) + xyzi)
        models.append((tx * TILE, ty * TILE, tz * TILE, size))

    # scene graph: node 0 = root transform, 1 = group, then (transform, shape) pairs
    nodes = b""
    nodes += _chunk(b"nTRN", struct.pack("<i", 0) + _dict({}) + struct.pack("<iiii", 1, -1, -1, 1) +
                    _dict({}))
    child_ids = [2 + 2 * i for i in range(len(models))]
    nodes += _chunk(b"nGRP", struct.pack("<i", 1) + _dict({}) + struct.pack("<i", len(models)) +
                    b"".join(struct.pack("<i", i) for i in child_ids))
    for i, (ox, oy, oz, size) in enumerate(models):
        t = f"{ox + size[0] // 2} {oy + size[1] // 2} {oz + size[2] // 2}"
        nodes += _chunk(b"nTRN", struct.pack("<i", 2 + 2 * i) + _dict({}) +
                        struct.pack("<iiii", 3 + 2 * i, -1, 0, 1) + _dict({"_t": t}))
        nodes += _chunk(b"nSHP", struct.pack("<i", 3 + 2 * i) + _dict({}) + struct.pack("<ii", 1, i) +
                        _dict({}))
    rgba = np.zeros((256, 4), np.uint8)
    rgba[:, 3] = 255
    rgba[:len(cents), :3] = cents
    body += nodes + _chunk(b"RGBA", rgba.tobytes())
    with open(output_path, "wb") as f:
        f.write(b"VOX " + struct.pack("<i", 150) + _chunk(b"MAIN", b"", body))
