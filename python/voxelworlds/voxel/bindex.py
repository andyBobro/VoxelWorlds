"""Building index (contract BuildingIndex): one entry per OSM building, tile independent.

Built once, in the parent process, from the global building list (never from tiles), so a building that spans
tiles appears exactly once and the result is a pure function of (OSM data, grid, terrain, config)."""
from __future__ import annotations

import json
import os
from typing import Dict, List, Optional

import numpy as np
from shapely.geometry.polygon import orient

from .grid import Grid, cells_in_geom
from .terrain import Terrain, ground_points


def element_id(piece_key: str) -> str:
    """'way/123#0' -> 'way/123'; further polygons of a multi-polygon element: 'relation/9#1'."""
    base, _, n = piece_key.partition("#")
    return base if n in ("", "0") else f"{base}#{n}"


def footprint_ring(poly, grid: Grid) -> List[List[float]]:
    """Outer ring in voxel-grid coordinates [x, z] (continuous voxel units, same axes as the voxels), open,
    in the order of the oriented UTM polygon (edge i = ring[i] -> ring[i+1]; seen from outside u runs along it)."""
    co = np.asarray(orient(poly, 1.0).exterior.coords)[:-1]
    x = (co[:, 0] - grid.e0) / grid.vs
    z = (grid.n0 - co[:, 1]) / grid.vs
    return [[round(float(a), 3), round(float(b), 3)] for a, b in zip(x, z)]


def build_index(records: list, buildings: list, grid: Grid, terrain: Optional[Terrain], mpf: float) -> dict:
    """records: dicts from extract_buildings(index_out=...). Entries whose footprint misses the grid or that
    produced no volume are omitted. Sorted by id."""
    by_key: Dict[str, list] = {}
    for b in buildings:
        by_key.setdefault(b.idx_key or b.key, []).append(b)
    vs = grid.vs
    out: List[dict] = []
    seen = set()
    for r in sorted(records, key=lambda r: r["key"]):
        members = by_key.get(r["key"])
        if not members:
            continue
        ix, iz = cells_in_geom(r["poly"], grid)
        if len(ix) == 0:
            pt = r["poly"].representative_point()
            cx, cz = int((pt.x - grid.e0) // vs), int((grid.n0 - pt.y) // vs)
            if not (0 <= cx < grid.nx and 0 <= cz < grid.nz):
                continue
            ix, iz = np.array([cx], np.int32), np.array([cz], np.int32)
        eid = element_id(r["key"])
        if eid in seen:
            continue
        seen.add(eid)
        base = int(ground_points(terrain, grid, iz, ix).min())
        height = max(m.height_m for m in members)
        top = max(base + max(2, int(round(m.height_m / vs))) + 1 for m in members)
        lv = r.get("lv")
        levels = int(round(lv)) if lv and lv > 0 else max(1, int(round(height / mpf)))
        e = dict(id=eid, kind=r["kind"], levels=max(1, levels), heightM=round(float(height), 3),
                 footprint=footprint_ring(r["poly"], grid), baseY=base + 1, topY=int(top))
        if r.get("name"):
            e["name"] = r["name"]
        out.append(e)
    out.sort(key=lambda e: e["id"])
    return {"version": 1, "buildings": out}


def write_index(path: str, index: dict) -> None:
    tmp = path + ".part"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(index, f, separators=(",", ":"), allow_nan=False)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
