"""VWG1 sparse voxel container reader/writer (little-endian)."""
from __future__ import annotations

import json
import struct
from typing import Any, Dict, Tuple

import numpy as np

MAGIC = b"VWG1"


def _pad4(n: int) -> int:
    return (4 - n % 4) % 4


def write_vwg(path: str, header: Dict[str, Any], x: np.ndarray, y: np.ndarray, z: np.ndarray,
              c: np.ndarray, check=None) -> None:
    """Write voxels (must already be sorted by (x,z,y)). header['voxelCount'] is set here."""
    header = dict(header)
    header["voxelCount"] = int(len(x))
    hb = json.dumps(header, separators=(",", ":")).encode("utf-8")
    cb = np.ascontiguousarray(c, dtype="<u2").tobytes()
    with open(path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<I", len(hb)))
        f.write(hb)
        f.write(b"\0" * _pad4(8 + len(hb)))
        for a in (x, y, z):
            mv = memoryview(np.ascontiguousarray(a, dtype="<i4")).cast("B")      # no extra copy
            for o in range(0, len(mv), 8 << 20):
                if check:
                    check()
                f.write(mv[o:o + (8 << 20)])
        f.write(cb)
        f.write(b"\0" * _pad4(len(cb)))


def read_vwg(path: str) -> Tuple[Dict[str, Any], np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    with open(path, "rb") as f:
        buf = f.read()
    if buf[:4] != MAGIC:
        raise ValueError("not a VWG1 file")
    (hl,) = struct.unpack_from("<I", buf, 4)
    header = json.loads(buf[8:8 + hl].decode("utf-8"))
    off = 8 + hl + _pad4(8 + hl)
    n = int(header["voxelCount"])
    arrs = []
    for _ in range(3):
        arrs.append(np.frombuffer(buf, dtype="<i4", count=n, offset=off).copy())
        off += 4 * n
    c = np.frombuffer(buf, dtype="<u2", count=n, offset=off).copy()
    return header, arrs[0], arrs[1], arrs[2], c
