"""Custom JSON exporter: VWG header + voxel arrays (voxel coordinate frame identical to .vwg)."""
from __future__ import annotations

import json

from ..voxel.vwg import read_vwg


def export_json(input_path: str, output_path: str) -> None:
    header, x, y, z, c = read_vwg(input_path)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write('{"format":"voxelworlds-json","axes":"y-up, +x east, +z south","header":')
        json.dump(header, f, separators=(",", ":"))
        for name, arr in (("x", x), ("y", y), ("z", z), ("c", c)):
            f.write(f',"{name}":')
            f.write(json.dumps(arr.tolist(), separators=(",", ":")))
        f.write("}")
