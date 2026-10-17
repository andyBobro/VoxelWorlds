"""Voxel level walk check for generated interiors (used by test_interior.py and the fuzz scripts).

A walker is 1 cell wide, 1.8 m high, climbs/descends at most one stair riser (<= 0.2 m, at least one row) per step
and may only stand on solid voxels (no 'ground anywhere' shortcut: the floor must really be there). It starts on the
first cell BEHIND the entrance door of each building part and flood fills the solid exterior + interior voxels."""
from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

import numpy as np
from shapely.geometry import Point


def plan_world(plan, uv):
    """uv (plan frame of part 0) -> world E, N."""
    Ec, Nc, ang = plan.parts[0]["frame"]
    c, s = math.cos(math.radians(ang)), math.sin(math.radians(ang))
    u, v = uv
    return Ec + u * c - v * s, Nc + u * s + v * c


class Walk:
    """Dense occupancy of one building (cropped to its footprint) + flood fill."""

    def __init__(self, b, g, xyz: np.ndarray, extra: Optional[np.ndarray] = None):
        self.b, self.g, self.vs = b, g, g.vs
        ix = np.concatenate([b.wx, xyz[:, 0]]).astype(np.int64)
        iz = np.concatenate([b.wz, xyz[:, 2]]).astype(np.int64)
        self.x0, self.z0 = int(ix.min()) - 2, int(iz.min()) - 2
        self.nx, self.nz = int(ix.max()) - self.x0 + 3, int(iz.max()) - self.z0 + 3
        ys = [b.wy, xyz[:, 1]] + ([b.ry] if len(b.rx) else [])
        self.head = int(round(1.8 / self.vs))
        self.rise = max(1, int(0.2 / self.vs + 1e-9))
        self.ny = int(max(int(a.max()) for a in ys)) + 3 + self.head + self.rise
        occ = np.zeros((self.nx, self.ny, self.nz), bool)
        occ[b.wx - self.x0, b.wy, b.wz - self.z0] = True
        if len(b.rx):
            occ[b.rx - self.x0, b.ry, b.rz - self.z0] = True
        occ[xyz[:, 0] - self.x0, xyz[:, 1], xyz[:, 2] - self.z0] = True
        self.occ = occ
        # standable[x, y, z]: solid below, 'head' free rows from y up
        cs = np.concatenate([np.zeros((self.nx, 1, self.nz), np.int32), np.cumsum(occ, axis=1, dtype=np.int32)], axis=1)
        h = self.head
        clear = np.zeros_like(occ)
        clear[:, : self.ny - h, :] = (cs[:, h: self.ny, :] - cs[:, : self.ny - h, :]) == 0
        below = np.zeros_like(occ)
        below[:, 1:, :] = occ[:, :-1, :]
        self.S = below & clear
        self.seen = np.zeros_like(occ)

    def cell(self, E, N) -> Tuple[int, int]:
        return (int(math.floor((E - self.g.e0) / self.vs)), int(math.floor((self.g.n0 - N) / self.vs)))

    def standable(self, x, y, z) -> bool:
        x -= self.x0
        z -= self.z0
        return 0 <= x < self.nx and 0 <= y < self.ny and 0 <= z < self.nz and bool(self.S[x, y, z])

    def fill(self, start: Tuple[int, int, int]) -> int:
        sx, sy, sz = start[0] - self.x0, start[1], start[2] - self.z0
        if not self.S[sx, sy, sz]:
            return 0
        seen, S, occ, head, rise = self.seen, self.S, self.occ, self.head, self.rise
        seen[sx, sy, sz] = True
        fx, fy, fz = np.array([sx]), np.array([sy]), np.array([sz])
        total = 1
        while len(fx):
            nxs, nys, nzs = [], [], []
            for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                tx, tz = fx + dx, fz + dz
                okb = (tx >= 0) & (tx < self.nx) & (tz >= 0) & (tz < self.nz)
                for dy in range(-rise, rise + 1):
                    ty = fy + dy
                    ok = okb & (ty >= 0) & (ty < self.ny)
                    if not ok.any():
                        continue
                    idx = np.nonzero(ok)[0]
                    a, bb, c = tx[idx], ty[idx], tz[idx]
                    m = S[a, bb, c] & ~seen[a, bb, c]
                    if dy > 0:      # head room over the old cell for the raised position
                        for k in range(dy):
                            m &= ~occ[fx[idx], np.minimum(fy[idx] + head + k, self.ny - 1), fz[idx]]
                    idx = idx[m]
                    if len(idx):
                        nxs.append(tx[idx]); nys.append(ty[idx]); nzs.append(tz[idx])
            if not nxs:
                break
            nx_, ny_, nz_ = np.concatenate(nxs), np.concatenate(nys), np.concatenate(nzs)
            lin = (nx_.astype(np.int64) * self.ny + ny_) * self.nz + nz_
            _, first = np.unique(lin, return_index=True)
            fx, fy, fz = nx_[first], ny_[first], nz_[first]
            seen[fx, fy, fz] = True
            total += len(fx)
        return total

    def reached(self, x, y, z) -> bool:
        x -= self.x0
        z -= self.z0
        return 0 <= x < self.nx and 0 <= y < self.ny and 0 <= z < self.nz and bool(self.seen[x, y, z])

    def ascii(self, y: int, ref=None) -> str:
        rows = []
        for z in range(self.nz):
            rows.append("".join("R" if self.seen[x, y, z] else ("." if self.S[x, y, z] else ("#" if self.occ[x, y, z] or self.occ[x, y - 1, z] else " "))
                                for x in range(self.nx)))
        return "\n".join(rows)


def start_cell(w: Walk, plan, pp) -> Optional[Tuple[int, int, int]]:
    """first standable ground floor cell BEHIND the entrance door of part `pp` (None if there is none)."""
    ent = pp["ent"]
    D = plan.D
    y = plan.floor_ys[0] + 1
    for off in (D * w.vs + 0.5 * w.vs, D * w.vs + w.vs, D * w.vs + 1.5 * w.vs):
        E = ent["pt_b"][0] + ent["n_in"][0] * off
        N = ent["pt_b"][1] + ent["n_in"][1] * off
        x, z = w.cell(E, N)
        if w.standable(x, y, z):
            return (x, y, z)
    return None


def analyse(b, g, xyz, plan=None) -> Dict:
    """-> dict(start_ok, missing_levels, missing_rooms, nreach). Every part's entrance is a start."""
    plan = plan or b.detail.interior_plan
    res = dict(start_ok=True, missing_levels=[], missing_rooms=[], nreach=0, plan=None)
    if plan is None or not plan.parts:
        res["plan"] = "none"
        return res
    w = Walk(b, g, xyz)
    res["walk"] = w
    for pi, pp in enumerate(plan.parts):
        st = start_cell(w, plan, pp)
        if st is None:
            res["start_ok"] = False
            continue
        if not w.seen[st[0] - w.x0, st[1], st[2] - w.z0]:
            res["nreach"] += w.fill(st)
    for pi, pp in enumerate(plan.parts):
        for lv in pp["levels"]:
            y = lv["slab_top"] + 1
            for ri, r in enumerate(lv["rooms"]):
                if r["type"] == "stairs" or (r["type"] == "lift" and lv["level"] > 0):
                    continue
                poly = r["poly_uv"].buffer(-0.25)
                if poly.is_empty:
                    poly = r["poly_uv"].buffer(-0.1)
                if poly.is_empty:
                    poly = r["poly_uv"]
                u0, v0, u1, v1 = poly.bounds
                hit = False
                step = max(w.vs, 0.1)
                for u in np.arange(u0, u1 + 1e-9, step):
                    for v in np.arange(v0, v1 + 1e-9, step):
                        if not poly.contains(Point(u, v)):
                            continue
                        E, N = plan_world(plan, (u, v))
                        x, z = w.cell(E, N)
                        if w.reached(x, y, z):
                            hit = True
                            break
                    if hit:
                        break
                if not hit:
                    res["missing_rooms"].append((pi, lv["level"], r["type"], ri, round(r["poly_uv"].area, 1)))
        for lv in pp["levels"]:
            rooms = [ri for ri, r in enumerate(lv["rooms"]) if r["type"] not in ("stairs", "lift")]
            bad = {m[3] for m in res["missing_rooms"] if m[0] == pi and m[1] == lv["level"]}
            if rooms and all(ri in bad for ri in rooms):
                res["missing_levels"].append((pi, lv["level"]))
    return res
