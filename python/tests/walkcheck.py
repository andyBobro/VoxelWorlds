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


# ---------------------------------------------------------------------------------------------------------------
# Walking-demo entrances: a 0.6 m wide, 1.8 m high walker on a plain voxel scene (no Building object needed)
# ---------------------------------------------------------------------------------------------------------------
class SceneWalk:
    """Dense occupancy of a voxel scene cropped to its bounding box (+ margin) with a walker of 0.6 m x 1.8 m that
    climbs at most 0.2 m per step. ``S[x, y, z]``: the walker may stand with its feet in cell (x, y, z)
    (solid below the centre cell, the whole (2r+1)^2 column free for 1.8 m). ``fill`` is the Walk.fill flood."""

    def __init__(self, X, Y, Z, vs: float, margin: int = 4, build_s: bool = True, body: str = "disc"):
        self.vs = vs
        self.body = body        # "disc" = the client's collision body (see _rebuild_disc); "box" = an AABB (stricter)
        X, Y, Z = (np.asarray(a, np.int64) for a in (X, Y, Z))
        self.x0, self.z0 = int(X.min()) - margin, int(Z.min()) - margin
        self.nx, self.nz = int(X.max()) - self.x0 + 1 + margin, int(Z.max()) - self.z0 + 1 + margin
        self.head = int(math.ceil(1.8 / vs - 1e-9))
        self.rise = max(1, int(0.2 / vs + 1e-9))
        self.r = int(math.ceil((0.3 - 0.5 * vs) / vs - 1e-9))     # cells beside the centre cell under a 0.6 m box
        self.ny = int(Y.max()) + 3 + self.head + self.rise
        self.occ = np.zeros((self.nx, self.ny, self.nz), bool)
        self.occ[X - self.x0, Y, Z - self.z0] = True
        self.seen = np.zeros_like(self.occ)
        if build_s:
            self.rebuild()

    def rebuild(self):
        """S[x, y, z] = the client's body (the Mover's swept AABB: 0.6 m square footprint, 1.8 m tall) can rest with its
        feet at row y over cell (x, z): no solid voxel anywhere in the footprint between the feet and 1.8 m above, and
        at least one footprint cell supports it (solid at row y-1: the box sits on the highest cell under it, which is
        how it stands on a ramp)."""
        occ, h, r, ny = self.occ, self.head, self.r, self.ny
        if self.body == "disc":
            return self._rebuild_disc()
        cs = np.concatenate([np.zeros((self.nx, 1, self.nz), np.int32), np.cumsum(occ, axis=1, dtype=np.int32)], axis=1)
        cs = np.concatenate([cs, np.repeat(cs[:, -1:, :], h + 1, axis=1)], axis=1)     # rows above the scene are empty
        blocked = (cs[:, h: h + ny, :] - cs[:, 0: ny, :]) > 0
        below = np.zeros_like(occ)
        below[:, 1:, :] = occ[:, :-1, :]

        def dilate(a):
            d = a.copy()
            for k in range(1, r + 1):
                d[k:, :, :] |= a[:-k, :, :]
                d[:-k, :, :] |= a[k:, :, :]
            d2 = d.copy()
            for k in range(1, r + 1):
                d2[:, :, k:] |= d[:, :, :-k]
                d2[:, :, :-k] |= d[:, :, k:]
            return d2
        self.S = dilate(below) & ~dilate(blocked)

    def _rebuild_disc(self):
        """the client's current body: a disc of radius 0.3 m, 1.8 m tall. A position is standable if no solid voxel
        column rectangle that the disc overlaps (rectangle distance to the centre < 0.3 m) has a voxel between the feet
        and 1.8 m above, and some overlapped column supports it (the body rests on the highest voxel under it)."""
        occ, h, ny = self.occ, self.head, self.ny
        R = 0.3 - 1e-6
        n = int(math.ceil(R / self.vs)) + 1
        offs = [(dx, dz) for dx in range(-n, n + 1) for dz in range(-n, n + 1)
                if max(abs(dx) * self.vs - self.vs / 2, 0.0) ** 2 + max(abs(dz) * self.vs - self.vs / 2, 0.0) ** 2 < R * R]
        cs = np.concatenate([np.zeros((self.nx, 1, self.nz), np.int32), np.cumsum(occ, axis=1, dtype=np.int32)], axis=1)
        cs = np.concatenate([cs, np.repeat(cs[:, -1:, :], h + 1, axis=1)], axis=1)
        blocked = (cs[:, h: h + ny, :] - cs[:, 0: ny, :]) > 0
        below = np.zeros_like(occ)
        below[:, 1:, :] = occ[:, :-1, :]

        def dilate(a):
            o = np.zeros_like(a)
            for dx, dz in offs:
                xs0, xs1 = max(0, dx), self.nx + min(0, dx)
                zs0, zs1 = max(0, dz), self.nz + min(0, dz)
                o[xs0:xs1, :, zs0:zs1] |= a[xs0 - dx:xs1 - dx, :, zs0 - dz:zs1 - dz]
            return o
        self.S = dilate(below) & ~dilate(blocked)

    def fill8(self, start, rise: int = 1) -> int:
        """flood fill over S in 8 directions (no squeezing between two diagonal corners), +-rise rows per move."""
        sx, sy, sz = start[0] - self.x0, start[1], start[2] - self.z0
        S, seen = self.S, self.seen
        if not S[sx, sy, sz]:
            return 0
        seen[sx, sy, sz] = True
        fx, fy, fz = np.array([sx]), np.array([sy]), np.array([sz])
        total = 1
        while len(fx):
            nxs, nys, nzs = [], [], []
            for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                tx, tz = fx + dx, fz + dz
                okb = (tx >= 0) & (tx < self.nx) & (tz >= 0) & (tz < self.nz)
                for dy in range(-rise, rise + 1):
                    ty = fy + dy
                    ok = okb & (ty >= 0) & (ty < self.ny)
                    idx = np.nonzero(ok)[0]
                    if not len(idx):
                        continue
                    a, b, c = tx[idx], ty[idx], tz[idx]
                    m = S[a, b, c] & ~seen[a, b, c]
                    if dx and dz:
                        ox, oz = fx[idx], fz[idx]
                        m &= S[a, b, oz] | S[ox, b, c]
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

    def cell(self, xm: float, zm: float):
        """metres of the detail .vwg frame -> voxel (ix, iz)."""
        return int(math.floor(xm / self.vs + 1e-9)), int(math.floor(zm / self.vs + 1e-9))

    def standable(self, x, y, z) -> bool:
        x -= self.x0
        z -= self.z0
        return 0 <= x < self.nx and 0 <= y < self.ny and 0 <= z < self.nz and bool(self.S[x, y, z])

    def reached(self, x, y, z) -> bool:
        x -= self.x0
        z -= self.z0
        return 0 <= x < self.nx and 0 <= y < self.ny and 0 <= z < self.nz and bool(self.seen[x, y, z])

    def fill(self, start):
        if self.body == "disc":       # the client's disc moves in any direction and rises by up to its 0.35 m step
            return self.fill8(start, max(1, int(0.35 / self.vs + 1e-9)))
        return Walk.fill(self, start)


def check_entrance(sw: "SceneWalk", ent: Dict) -> List[str]:
    """-> list of problems of one entrance record on the scene (empty = OK). The doorway is carved in the voxels: no opening step."""
    vs = sw.vs
    bad: List[str] = []
    ix, iy, iz = ent["inside"]
    ox, oy, oz = ent["outside"]
    if abs(math.hypot(*ent["dir"]) - 1.0) > 1e-3:
        bad.append("dir is not a unit vector")
    if (ix - ox) * ent["dir"][0] + (iz - oz) * ent["dir"][1] <= 0:
        bad.append("dir does not point from outside to inside")
    if ent["widthM"] < 0.9 - 1e-9:
        bad.append(f"door width {ent['widthM']}")
    if abs(iy - oy) > 1e-6:
        bad.append("inside/outside feet at different heights")
    y = int(round(iy / vs))
    if abs(y * vs - iy) > 1e-3:
        bad.append("feet y is not on a voxel face")
    a = sw.cell(ix, iz); b = sw.cell(ox, oz)
    if not sw.standable(a[0], y, a[1]):
        bad.append("inside is not standable (wall/furniture/low ceiling/no floor)")
    # outside: on the ground, or on a painted threshold step of up to 0.2 m in front of a facade door (the Mover
    # rests on the highest voxel under its box)
    yo = next((yy for yy in range(y, y + max(1, int(0.2 / vs + 1e-9)) + 1) if sw.standable(b[0], yy, b[1])), None)
    if yo is None:
        bad.append("outside is not standable")
    if bad:
        return bad
    sw.seen[:] = False
    sw.fill((b[0], yo, b[1]))
    if not sw.reached(a[0], y, a[1]):
        bad.append("no walkable path from outside to inside")
    return bad


# ---------------------------------------------------------------------------------------------------------------
# Port of src/renderer/walk/physics.ts (Mover): the swept 0.6 x 1.8 m AABB the walking client uses.
# Indoors the client steps up 0.35 m (Scale.indoorStepUp), no jumping (jump input is never given here).
# ---------------------------------------------------------------------------------------------------------------
HALF_W, HEIGHT, GRAVITY, EPS, COYOTE = 0.3, 1.8, 20.0, 1e-6, 0.1


class Mover:
    def __init__(self, sw: "SceneWalk", step_up: float = 0.35, walk_speed: float = 3.0, body: str = "disc"):
        """body: "disc" = the client's current collision body (1.8 m cylinder of diameter 0.6 m: swept circle with
        move-and-slide, see src/renderer/walk/physics.ts); "box" = the former 0.6 m square AABB (kept for comparison)."""
        self.body = body
        self.sw, self.vs = sw, sw.vs
        self.step_up, self.speed = step_up, walk_speed
        self.p = [0.0, 0.0, 0.0]
        self.vx = self.vy = self.vz = 0.0
        self.on_ground = False
        self.air_time = 0.0
        self.hit = False
        self.blocked = False
        self.lo = [-HALF_W, 0.0, -HALF_W]
        self.hi = [HALF_W, HEIGHT, HALF_W]

    def solid(self, ix, iy, iz) -> bool:
        s = self.sw
        x, z = ix - s.x0, iz - s.z0
        if x < 0 or x >= s.nx or z < 0 or z >= s.nz:
            return True
        if iy < 0 or iy >= s.ny:
            return False
        return bool(s.occ[x, iy, z])

    def layer_solid(self, a: int, m: int) -> bool:
        vs, p = self.vs, self.p
        b = 1 if a == 0 else 0
        c = 1 if a == 2 else 2
        b_lo = math.floor((p[b] + self.lo[b] + EPS) / vs); b_hi = math.floor((p[b] + self.hi[b] - EPS) / vs)
        c_lo = math.floor((p[c] + self.lo[c] + EPS) / vs); c_hi = math.floor((p[c] + self.hi[c] - EPS) / vs)
        idx = [0, 0, 0]
        idx[a] = m
        for ib in range(b_lo, b_hi + 1):
            idx[b] = ib
            for ic in range(c_lo, c_hi + 1):
                idx[c] = ic
                if self.solid(*idx):
                    return True
        return False

    def overlaps(self) -> bool:
        if self.body == "disc":
            return self.overlaps_disc()
        vs, p = self.vs, self.p
        x0 = math.floor((p[0] - HALF_W + EPS) / vs); x1 = math.floor((p[0] + HALF_W - EPS) / vs)
        y0 = math.floor((p[1] + EPS) / vs); y1 = math.floor((p[1] + HEIGHT - EPS) / vs)
        z0 = math.floor((p[2] - HALF_W + EPS) / vs); z1 = math.floor((p[2] + HALF_W - EPS) / vs)
        return any(self.solid(x, y, z) for x in range(x0, x1 + 1) for z in range(z0, z1 + 1) for y in range(y0, y1 + 1))

    def sweep(self, a: int, d: float) -> float:
        self.hit = False
        if d == 0:
            return 0.0
        vs, p = self.vs, self.p
        if d > 0:
            face = p[a] + self.hi[a]
            target = face + d
            first = math.floor((face - EPS) / vs) + 1
            last = math.floor((target - EPS) / vs)
            for m in range(first, last + 1):
                if self.layer_solid(a, m):
                    moved = max(0.0, m * vs - face)
                    p[a] += moved
                    self.hit = True
                    return moved
            p[a] += d
            return d
        face = p[a] + self.lo[a]
        target = face + d
        first = math.floor((face + EPS) / vs) - 1
        last = math.floor((target + EPS) / vs)
        for m in range(first, last - 1, -1):
            if self.layer_solid(a, m):
                moved = min(0.0, (m + 1) * vs - face)
                p[a] += moved
                self.hit = True
                return moved
        p[a] += d
        return d

    # ---- disc body (port of the TypeScript Mover: swept circle, move-and-slide, destination-only step-up)
    def col_solid(self, ix, iz, iy0, iy1) -> bool:
        s = self.sw
        x, z = ix - s.x0, iz - s.z0
        if x < 0 or x >= s.nx or z < 0 or z >= s.nz:
            return True
        y0, y1 = max(iy0, 0), min(iy1, s.ny - 1)
        return y0 <= y1 and bool(s.occ[x, y0:y1 + 1, z].any())

    def disc_hits(self, ix, iz, px, pz) -> bool:
        vs = self.vs
        x0, z0 = ix * vs, iz * vs
        dx = max(x0 - px, 0.0, px - (x0 + vs))
        dz = max(z0 - pz, 0.0, pz - (z0 + vs))
        r = HALF_W - EPS
        return dx * dx + dz * dz < r * r

    def layer_solid_disc(self, m: int) -> bool:
        vs, px, pz = self.vs, self.p[0], self.p[2]
        for ix in range(math.floor((px - HALF_W) / vs), math.floor((px + HALF_W) / vs) + 1):
            for iz in range(math.floor((pz - HALF_W) / vs), math.floor((pz + HALF_W) / vs) + 1):
                if self.disc_hits(ix, iz, px, pz) and self.solid(ix, m, iz):
                    return True
        return False

    def overlaps_disc(self) -> bool:
        vs, px, pz = self.vs, self.p[0], self.p[2]
        y0 = math.floor((self.p[1] + EPS) / vs)
        y1 = math.floor((self.p[1] + HEIGHT - EPS) / vs)
        for ix in range(math.floor((px - HALF_W) / vs), math.floor((px + HALF_W) / vs) + 1):
            for iz in range(math.floor((pz - HALF_W) / vs), math.floor((pz + HALF_W) / vs) + 1):
                if self.disc_hits(ix, iz, px, pz) and self.col_solid(ix, iz, y0, y1):
                    return True
        return False

    def sweep_y_disc(self, d: float) -> float:
        self.hit = False
        if d == 0:
            return 0.0
        vs, p = self.vs, self.p
        if d > 0:
            face = p[1] + HEIGHT
            for m in range(math.floor((face - EPS) / vs) + 1, math.floor((face + d - EPS) / vs) + 1):
                if self.layer_solid_disc(m):
                    moved = max(0.0, m * vs - face)
                    p[1] += moved
                    self.hit = True
                    return moved
            p[1] += d
            return d
        face = p[1]
        for m in range(math.floor((face + EPS) / vs) - 1, math.floor((face + d + EPS) / vs) - 1, -1):
            if self.layer_solid_disc(m):
                moved = min(0.0, (m + 1) * vs - face)
                p[1] += moved
                self.hit = True
                return moved
        p[1] += d
        return d

    def sweep_y(self, d: float) -> float:
        return self.sweep_y_disc(d) if self.body == "disc" else self.sweep(1, d)

    def rect_impact(self, x0, z0, x1, z1, px, pz, rx, rz):
        """-> (t, nx, nz): time of impact of the disc centre moving by (rx, rz) with the column rectangle."""
        R = HALF_W
        cx = min(max(px, x0), x1)
        cz = min(max(pz, z0), z1)
        ddx, ddz = px - cx, pz - cz
        d2 = ddx * ddx + ddz * ddz
        if d2 < (R - EPS) ** 2:
            d = math.sqrt(d2)
            if d > 1e-9:
                nx, nz = ddx / d, ddz / d
            else:
                l, r_, t_, b_ = px - x0, x1 - px, pz - z0, z1 - pz
                m = min(l, r_, t_, b_)
                nx, nz = (-1, 0) if m == l else (1, 0) if m == r_ else (0, -1) if m == t_ else (0, 1)
            return (0.0, nx, nz) if rx * nx + rz * nz < -1e-9 else (math.inf, 0.0, 0.0)
        best, bnx, bnz = math.inf, 0.0, 0.0
        if rx > 0:
            t = (x0 - R - px) / rx
            if -1e-9 <= t < best and z0 <= pz + rz * t <= z1:
                best, bnx, bnz = t, -1.0, 0.0
        elif rx < 0:
            t = (x1 + R - px) / rx
            if -1e-9 <= t < best and z0 <= pz + rz * t <= z1:
                best, bnx, bnz = t, 1.0, 0.0
        if rz > 0:
            t = (z0 - R - pz) / rz
            if -1e-9 <= t < best and x0 <= px + rx * t <= x1:
                best, bnx, bnz = t, 0.0, -1.0
        elif rz < 0:
            t = (z1 + R - pz) / rz
            if -1e-9 <= t < best and x0 <= px + rx * t <= x1:
                best, bnx, bnz = t, 0.0, 1.0
        a = rx * rx + rz * rz
        for k in range(4):
            ccx, ccz = (x1 if k & 1 else x0), (z1 if k & 2 else z0)
            sx, sz = (1 if k & 1 else -1), (1 if k & 2 else -1)
            fx, fz = px - ccx, pz - ccz
            b = 2 * (rx * fx + rz * fz)
            if b >= -1e-9:
                continue
            disc = b * b - 4 * a * (fx * fx + fz * fz - R * R)
            if disc < 0:
                continue
            t = (-b - math.sqrt(disc)) / (2 * a)
            if t < -1e-9 or t >= best:
                continue
            hx, hz = px + rx * t - ccx, pz + rz * t - ccz
            if hx * sx < -1e-9 or hz * sz < -1e-9:
                continue
            best, bnx, bnz = t, hx / R, hz / R
        return best, bnx, bnz

    def impact(self, rx, rz):
        vs, px, pz = self.vs, self.p[0], self.p[2]
        iy0 = math.floor((self.p[1] + EPS) / vs)
        iy1 = math.floor((self.p[1] + HEIGHT - EPS) / vs)
        best = (math.inf, 0.0, 0.0)
        for ix in range(math.floor((min(px, px + rx) - HALF_W) / vs), math.floor((max(px, px + rx) + HALF_W) / vs) + 1):
            for iz in range(math.floor((min(pz, pz + rz) - HALF_W) / vs), math.floor((max(pz, pz + rz) + HALF_W) / vs) + 1):
                if not self.col_solid(ix, iz, iy0, iy1):
                    continue
                r = self.rect_impact(ix * vs, iz * vs, (ix + 1) * vs, (iz + 1) * vs, px, pz, rx, rz)
                if r[0] < best[0]:
                    best = r
        return best

    def slide(self, dx: float, dz: float) -> float:
        rx, rz, total = dx, dz, 0.0
        self.blocked = False
        for _ in range(3):
            ln = math.hypot(rx, rz)
            if ln < 1e-9:
                break
            t, nx, nz = self.impact(rx, rz)
            if t >= 1:
                self.p[0] += rx
                self.p[2] += rz
                total += ln
                break
            self.blocked = True
            tt = max(t, 0.0)
            self.p[0] += rx * tt
            self.p[2] += rz * tt
            total += ln * tt
            rem = 1 - tt
            sx, sz = rx * rem, rz * rem
            dot = sx * nx + sz * nz
            rx, rz = sx - dot * nx, sz - dot * nz
        return total

    def move_xz(self, dx: float, dz: float, can_step: bool):
        if dx == 0 and dz == 0:
            return
        x0, y0, z0 = self.p
        prog = self.slide(dx, dz)
        if not self.blocked or not can_step:
            return
        bx, bz = self.p[0], self.p[2]
        vs = self.vs
        lift = (math.floor((y0 + EPS) / vs) + 1) * vs - y0
        for _ in range(40):
            last = lift >= self.step_up - 1e-9
            L = self.step_up if last else lift
            self.p[0], self.p[2], self.p[1] = x0, z0, y0 + L
            pr = self.slide(dx, dz)
            if pr > prog + 1e-6 and not self.overlaps():
                self.sweep_y_disc(-L)
                return
            if last:
                break
            lift += vs
        self.p[0], self.p[2], self.p[1] = bx, bz, y0

    def teleport(self, x, y, z):
        self.p = [x, y, z]
        self.vx = self.vy = self.vz = 0.0
        self.on_ground = False
        self.air_time = 0.0
        for _ in range(400):
            if not self.overlaps():
                break
            self.p[1] += max(self.vs, 0.1)

    def move_horiz(self, a: int, d: float, can_step: bool):
        """port of Mover.moveHoriz: smallest lift (to the next voxel boundary, ..., finally step_up) at which the
        DESTINATION box is free (only the destination is tested, not the raised start box)."""
        if d == 0:
            return
        moved = self.sweep(a, d)
        if not self.hit or not can_step:
            return
        remaining = d - moved
        if abs(remaining) < 1e-9:
            return
        vs = self.vs
        y0, a0 = self.p[1], self.p[a]
        lift = (math.floor((y0 + EPS) / vs) + 1) * vs - y0
        for _ in range(40):
            last = lift >= self.step_up - 1e-9
            L = self.step_up if last else lift
            self.p[1] = y0 + L
            m2 = self.sweep(a, remaining)
            if abs(m2) > EPS and not self.overlaps():
                self.sweep(1, -L)
                return
            self.p[a] = a0
            if last:
                break
            lift += vs
        self.p[1] = y0

    def step(self, dt: float, wish_x: float, wish_z: float):
        dt = min(dt, 0.1)
        g = GRAVITY
        was_ground = self.on_ground
        sp = self.speed
        tx, tz = wish_x * sp, wish_z * sp
        acc = (80 if self.on_ground else 30) * dt
        ex, ez = tx - self.vx, tz - self.vz
        el = math.hypot(ex, ez)
        if el <= acc:
            self.vx, self.vz = tx, tz
        else:
            self.vx += ex / el * acc
            self.vz += ez / el * acc
        total = (math.hypot(self.vx, self.vz) + abs(self.vy)) * dt
        max_move = min(0.25, self.vs * 0.9)
        n = max(1, min(16, math.ceil(total / max_move)))
        h = dt / n
        grounded = False
        for _ in range(n):
            can_step = (was_ground or self.air_time < COYOTE) and self.vy <= 0.01
            if self.body == "disc":
                self.move_xz(self.vx * h, self.vz * h, can_step)
            else:
                self.move_horiz(0, self.vx * h, can_step)
                self.move_horiz(2, self.vz * h, can_step)
            snapped = False
            if can_step and self.vy <= 0.01:
                y0 = self.p[1]
                self.sweep_y(-self.step_up)
                if self.hit:
                    snapped = True
                    self.vy = 0.0
                else:
                    self.p[1] = y0
            if not snapped:
                dy = self.vy * h - 0.5 * g * h * h
                self.vy -= g * h
                self.vy = max(self.vy, -60.0)
                self.sweep_y(dy)
                if self.hit:
                    if dy < 0:
                        snapped = True
                    self.vy = 0.0
            grounded = snapped
            self.air_time = 0.0 if grounded else self.air_time + h
            self.on_ground = grounded
        self.on_ground = grounded

    def walk_to(self, targets, tol: float = 0.15, max_t: float = 40.0, dt: float = 1 / 60):
        """steer through horizontal waypoints [(x, z), ...]; -> True when the last one was reached."""
        t = 0.0
        for (tx, tz) in targets:
            while True:
                dx, dz = tx - self.p[0], tz - self.p[2]
                d = math.hypot(dx, dz)
                if d < tol:
                    break
                if t > max_t:
                    return False
                self.step(dt, dx / d, dz / d)
                t += dt
        return True


def _lane_shift(plan, g, sw, sp, L, b_lo, b_hi) -> float:
    """lateral offset (m, along eb) from the nominal lane centre to the middle of the FREE run of the lane measured on
    the voxels half way up the flight: cells whose column has a wall above the tread are not free."""
    vs = g.vs
    o, ea, eb = sp["o"], sp["ea"], sp["eb"]
    fy = plan.floor_ys
    a = sp["La"] / 2.0
    bc = 0.5 * (b_lo + b_hi)
    free = []
    for bb in np.arange(b_lo + vs / 4, b_hi, vs / 2):
        E, N = plan_world(plan, (o[0] + ea[0] * a + eb[0] * bb, o[1] + ea[1] * a + eb[1] * bb))
        x, z = int(math.floor((E - g.e0) / vs)) - sw.x0, int(math.floor((g.n0 - N) / vs)) - sw.z0
        ys = np.nonzero(sw.occ[x, fy[L]: fy[L + 1] + 1, z])[0] + fy[L]
        if len(ys) == 0:
            free.append(False)
            continue
        t = int(ys.max())
        free.append(not sw.occ[x, t + 1: t + 7, z].any())
    best = None
    start = None
    for k, f in enumerate(free + [False]):
        if f and start is None:
            start = k
        if not f and start is not None:
            run = (start, k - 1)
            if best is None or run[1] - run[0] > best[1] - best[0]:
                best = run
            start = None
    if best is None:
        return 0.0
    bm = b_lo + vs / 4 + 0.5 * (best[0] + best[1]) * vs / 2
    return bm - bc


def stair_waypoints(plan, sp, g=None, sw=None, L=0):
    """horizontal waypoints (world E, N) of one flight in walking order: bottom apron -> up the body -> top exit.
    With (g, sw) the lane centre is taken from the free cells of the voxels (walls take cells away on both sides)."""
    o, ea, eb, La, Wb, sws = sp["o"], sp["ea"], sp["eb"], sp["La"], sp["Wb"], sp["sw"]

    def uv(a, b):
        return plan_world(plan, (o[0] + ea[0] * a + eb[0] * b, o[1] + ea[1] * a + eb[1] * b))
    if sp["kind"] == "S":
        d = _lane_shift(plan, g, sw, sp, L, 0.0, Wb) if sw is not None else 0.0
        return [uv(-0.75, Wb / 2 + d), uv(La + 0.75, Wb / 2 + d)]
    dA = _lane_shift(plan, g, sw, sp, L, 0.0, sws) if sw is not None else 0.0
    dB = _lane_shift(plan, g, sw, sp, L, sws, 2 * sws) if sw is not None else 0.0
    return [uv(-0.75, sws / 2 + dA), uv(La - sws / 2, sws / 2 + dA), uv(La - sws / 2, 1.5 * sws + dB),
            uv(-0.75, 1.5 * sws + dB)]


def climb_all_flights(b, g, X, Y, Z, step_up: float = 0.35) -> List[str]:
    """Walk every flight of every stair core with the client's Mover; -> list of problems (empty = all storeys climbable)."""
    plan = b.detail.interior_plan
    sw = SceneWalk(X, Y, Z, g.vs, build_s=False)
    vs = g.vs
    bad: List[str] = []
    fy = plan.floor_ys
    for pi, pp in enumerate(plan.parts):
        n = len(pp["levels"])
        for si, sp in enumerate(pp["specs"] if n > 1 else []):
            for L in range(n - 1):
                wps = [(E - g.e0, g.n0 - N) for E, N in stair_waypoints(plan, sp, g, sw, L)]
                m = Mover(sw, step_up=step_up)
                m.teleport(wps[0][0], (fy[L] + 1) * vs + 0.002, wps[0][1])
                ok = m.walk_to(wps[1:])
                for _ in range(30):
                    m.step(1 / 60, 0.0, 0.0)
                top = (fy[L + 1] + 1) * vs
                if not ok or m.p[1] < top - 0.02:
                    bad.append(f"part {pi} stair {si} flight {L}->{L + 1}: stuck at y={m.p[1]:.2f} (need {top:.2f}), "
                               f"x={m.p[0]:.2f} z={m.p[2]:.2f}")
    return bad


def stair_headroom(b, g, X, Y, Z, xyz, codes, detail: bool = False):
    """smallest number of free rows straight above any tread top (voxels painted with the stair top colour) of every
    flight, counted up to the next solid voxel of the scene (the soffit of the flight above, a slab or the roof)."""
    from voxelworlds.voxel import interior
    vs = g.vs
    plaster = ((interior.C_PLASTER[0] << 16 | interior.C_PLASTER[1] << 8 | interior.C_PLASTER[2]) << 3) | interior.MW
    sw = SceneWalk(X, Y, Z, vs, build_s=False)
    P = np.asarray(xyz)[np.asarray(codes) == plaster]      # side walls of the stair well on the lane edges do not count
    # (a plaster voxel is only dropped when the scene has no other voxel there, i.e. it is an interior partition)
    sw.occ[P[:, 0] - sw.x0, P[:, 1], P[:, 2] - sw.z0] = False
    want = ((interior.C_STAIR[0] << 16 | interior.C_STAIR[1] << 8 | interior.C_STAIR[2]) << 3) | interior.MW
    T = np.asarray(xyz)[np.asarray(codes) == want]
    best, where = 10 ** 9, None
    plan = b.detail.interior_plan
    Ec, Nc, ang = plan.parts[0]["frame"]
    cs_, sn_ = math.cos(math.radians(ang)), math.sin(math.radians(ang))
    specs = [sp for pp in plan.parts for sp in pp["specs"]]

    def in_spine(x, z) -> bool:       # the wall between the two lanes of a U stair is not a place to stand
        E, N = g.e0 + (x + 0.5) * vs, g.n0 - (z + 0.5) * vs
        u, v = (E - Ec) * cs_ + (N - Nc) * sn_, -(E - Ec) * sn_ + (N - Nc) * cs_
        for sp in specs:
            if sp["kind"] != "U":
                continue
            bb = (u - sp["o"][0]) * sp["eb"][0] + (v - sp["o"][1]) * sp["eb"][1]
            aa = (u - sp["o"][0]) * sp["ea"][0] + (v - sp["o"][1]) * sp["ea"][1]
            if abs(bb - sp["sw"]) < 0.2 and 0 <= aa < sp["La"] - sp["sw"]:
                return True
        return False
    for (x, y, z) in T:
        if in_spine(x, z):
            continue
        col = sw.occ[x - sw.x0, :, z - sw.z0]
        above = np.nonzero(col[y + 1:])[0]
        free = int(above[0]) if len(above) else 10 ** 9
        if free < best:
            best, where = free, (int(x), int(y), int(z))
    return (best, where) if detail else best


def bfs_route(sw: "SceneWalk", start, goal_y: int, rise: int = 1):
    """breadth-first route over standable cells (4-neighbour, +-rise rows per move) from voxel cell `start` (x, y, z) to
    the first cell with y >= goal_y; -> list of metre positions (cell centre x/z, feet y) or None."""
    import collections
    S, vs = sw.S, sw.vs
    s0 = (start[0] - sw.x0, start[1], start[2] - sw.z0)
    prev = {s0: None}
    q = collections.deque([s0])
    goal = None
    while q:
        c = q.popleft()
        if c[1] >= goal_y:
            goal = c
            break
        for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            for dy in range(-rise, rise + 1):
                n = (c[0] + dx, c[1] + dy, c[2] + dz)
                if n in prev or not (0 <= n[0] < sw.nx and 0 <= n[1] < sw.ny and 0 <= n[2] < sw.nz) or not S[n]:
                    continue
                prev[n] = c
                q.append(n)
    if goal is None:
        return None
    out, c = [], goal
    while c:
        out.append([(c[0] + sw.x0 + 0.5) * vs, c[1] * vs, (c[2] + sw.z0 + 0.5) * vs])
        c = prev[c]
    return out[::-1]


def drive_route(sw: "SceneWalk", path, max_t: float = 240.0, step_up: float = 0.35):
    """hold-W steering with the client's Mover along `path` (always towards the current waypoint, advance within
    0.12 m); -> (reached the last waypoint's height, highest feet y reached)."""
    m = Mover(sw, step_up=step_up)
    m.teleport(path[0][0], path[0][1] + 0.002, path[0][2])
    for _ in range(60):
        m.step(1 / 60, 0.0, 0.0)
    idx, maxy, top = 1, 0.0, path[-1]
    for _ in range(int(max_t * 60)):
        while idx < len(path) - 1 and math.hypot(path[idx][0] - m.p[0], path[idx][2] - m.p[2]) < 0.12:
            idx += 1
        dx, dz = path[idx][0] - m.p[0], path[idx][2] - m.p[2]
        n = math.hypot(dx, dz) or 1.0
        m.step(1 / 60, dx / n, dz / n)
        maxy = max(maxy, m.p[1])
        if m.p[1] >= top[1] - 0.05 and math.hypot(top[0] - m.p[0], top[2] - m.p[2]) < 0.4:
            return True, maxy
    return maxy >= top[1] - 0.05, maxy
