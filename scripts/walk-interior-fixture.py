"""Generates real interiors for the walking client's regression test (tests/walk-real-interior.test.ts).

Usage (from python/): ./.venv/bin/python -B ../scripts/walk-interior-fixture.py <outdir>
then:                  WALK_INTERIOR_DIR=<outdir> npx vitest run tests/walk-real-interior.test.ts

Builds houses and offices (axis aligned and rotated 33 / 90 / 135 degrees) at 0.15 and 0.2 m voxels with the real
interior generator, writes for each <name>.vwg (voxels incl. a ground plate, carved doorway), <name>.json
(DetailStats subset: entrances, floorYs) and <name>.routes.json: breadth-first routes for the client's body (a
cylinder of diameter 0.6 m, 1.8 m tall; 0.35 m automatic step) from the first entrance's `inside` cell to
  * every ground-floor room (kind "room"), and
  * the floor of the highest storey (kind "top"),
in detail-frame metres [x, feet y, z]. A destination for which no route exists is listed under "unreachable" so the
test fails with the room name instead of silently passing.
"""
import collections
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'python', 'tests'))
sys.path.insert(0, os.path.join(ROOT, 'python'))
import numpy as np  # noqa: E402
from test_interior import make_building, run, rect  # noqa: E402
from test_entrances import rotated, scene_of  # noqa: E402
import walkcheck  # noqa: E402
from voxelworlds.voxel.vwg import write_vwg  # noqa: E402

from voxelworlds.voxel import interior as _interior  # noqa: E402
if os.environ.get('STAIR_HEAD'):          # experiment: override the generator's stair head room (m)
    _interior.STAIR_HEAD = float(os.environ['STAIR_HEAD'])
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
R = 0.3 - 1e-6          # the client's disc radius; a body exactly touching a wall does not overlap it
STEP = 0.35
F = 3                   # horizontal lattice refinement (odd)


def fixtures():
    for vs in (0.15, 0.2):
        for deg in (0, 33, 90, 135):
            yield f"house_r{deg}_{vs}", rotated(rect(14, 9), deg), vs, dict(levels=3, height=10.6)
            yield f"office_r{deg}_{vs}", rotated(rect(26, 13), deg), vs, dict(levels=3, height=10.6, kind="commercial", btype="office")


def disc_offsets(vs):   # vs: horizontal lattice spacing
    """cell offsets (dx, dz) whose rectangle comes within R of the centre of the origin cell"""
    n = int(math.ceil(R / vs)) + 1
    out = []
    for dx in range(-n, n + 1):
        for dz in range(-n, n + 1):
            ax, az = max(abs(dx) * vs - vs / 2, 0.0), max(abs(dz) * vs - vs / 2, 0.0)
            if ax * ax + az * az < R * R:
                out.append((dx, dz))
    return out


def build(name, coords, vs, kw):
    b, g = make_building(coords, vs=vs, **kw)
    xyz, codes, _ = run(b, g)
    if not b.detail.entrances_raw:
        print(name, 'NO ENTRANCE')
        return
    X, Y, Z = scene_of(b, g, xyz)
    order = np.lexsort((Y, Z, X))      # sorted by (x, z, y)
    X, Y, Z = X[order], Y[order], Z[order]
    keep = np.concatenate([[True], (np.diff(X) != 0) | (np.diff(Z) != 0) | (np.diff(Y) != 0)])
    X, Y, Z = X[keep], Y[keep], Z[keep]
    header = dict(version=1, voxelSize=vs, origin=dict(utmZone=32, hemisphere='N', easting=g.e0, northing=g.n0, elevation=0, epsg=32632),
                  bbox=dict(latMin=0, lonMin=0, latMax=1, lonMax=1),
                  extent=dict(min=[int(X.min()), int(Y.min()), int(Z.min())], max=[int(X.max()) + 1, int(Y.max()) + 1, int(Z.max()) + 1]),
                  palette=[[0, 0, 0], [200, 190, 170]], stats=dict(voxelCount=len(X), buildingCount=1, buildingsWithPhotos=0, buildingsProcedural=1, elapsedMs=0))
    write_vwg(f"{OUT}/{name}.vwg", header, X, Y, Z, np.ones(len(X), np.uint16))
    ent = b.detail.entrances_raw[0]
    fys = list(b.detail.floor_ys_built)
    json.dump(dict(entrances=[dict(edge=0, city=[0, 0, 0], cityDir=[-ent['dir'][0], -ent['dir'][1]], inside=ent['inside'], outside=ent['outside'],
                                   dir=ent['dir'], widthM=ent['widthM'])], floorYs=fys, levels=len(fys)), open(f"{OUT}/{name}.json", 'w'))

    # --- routes for the disc body
    m = 3
    x0, z0 = int(X.min()) - m, int(Z.min()) - m
    nx, nz = int(X.max()) - x0 + 1 + m, int(Z.max()) - z0 + 1 + m
    head = int(math.ceil(1.8 / vs - 1e-9))
    ny = int(Y.max()) + 3 + head
    occ = np.zeros((nx, ny, nz), bool)
    occ[X - x0, Y, Z - z0] = True
    # route on an Fx finer horizontal lattice (F odd so the voxel centres are lattice points too) (the body is not confined to voxel centres: a 0.9 m doorway or a jagged
    # diagonal corridor can be passable although no voxel-centred position fits)
    occ = np.repeat(np.repeat(occ, F, axis=0), F, axis=2)
    nx, nz = nx * F, nz * F
    hs = vs / F
    offs = disc_offsets(hs)
    cs = np.concatenate([np.zeros((nx, 1, nz), np.int32), np.cumsum(occ, axis=1, dtype=np.int32)], axis=1)
    cs = np.concatenate([cs, np.repeat(cs[:, -1:, :], head + 1, axis=1)], axis=1)
    blocked = (cs[:, head:head + ny, :] - cs[:, 0:ny, :]) > 0       # any solid in [y, y+head) in the column
    bad = np.zeros_like(blocked)
    for dx, dz in offs:
        xs0, xs1, zs0, zs1 = max(0, dx), nx + min(0, dx), max(0, dz), nz + min(0, dz)
        bad[xs0:xs1, :, zs0:zs1] |= blocked[xs0 - dx:xs1 - dx, :, zs0 - dz:zs1 - dz]
    below = np.zeros_like(occ)
    below[:, 1:, :] = occ[:, :-1, :]
    sup = np.zeros_like(below)          # the body rests on the HIGHEST cell under its footprint (how it stands on a ramp)
    for dx, dz in offs:
        xs0, xs1, zs0, zs1 = max(0, dx), nx + min(0, dx), max(0, dz), nz + min(0, dz)
        sup[xs0:xs1, :, zs0:zs1] |= below[xs0 - dx:xs1 - dx, :, zs0 - dz:zs1 - dz]
    S = sup & ~bad
    rise = max(1, int(STEP / vs + 1e-9))

    sx, sz = int(math.floor(ent['inside'][0] / hs)) - F * x0, int(math.floor(ent['inside'][2] / hs)) - F * z0
    sy = int(round(ent['inside'][1] / vs))
    if not S[sx, sy, sz]:      # the lattice cell holding the point is not clear: take the nearest clear one (<= 0.3 m)
        cands = [(math.hypot(a, b), sx + a, sz + b) for a in range(-2 * F, 2 * F + 1) for b in range(-2 * F, 2 * F + 1)
                 if 0 <= sx + a < nx and 0 <= sz + b < nz and S[sx + a, sy, sz + b]]
        if not cands:
            print(name, 'start not standable for the disc', (sx, sy, sz))
            json.dump(dict(unreachable=['start'], routes=[]), open(f"{OUT}/{name}.routes.json", 'w'))
            return
        _, sx, sz = min(cands)
    prev = {(sx, sy, sz): None}
    q = collections.deque([(sx, sy, sz)])
    while q:
        c = q.popleft()
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                if not dx and not dz:
                    continue
                for dy in range(-rise, rise + 1):
                    n = (c[0] + dx, c[1] + dy, c[2] + dz)
                    if n in prev or not (0 <= n[0] < nx and 0 <= n[1] < ny and 0 <= n[2] < nz) or not S[n]:
                        continue
                    if dx and dz and not (S[c[0] + dx, c[1], c[2]] or S[c[0], c[1], c[2] + dz]):
                        continue      # no squeezing between two diagonal corners
                    prev[n] = c
                    q.append(n)

    def route(goal):
        path, c = [], goal
        while c:
            path.append([round((c[0] + F * x0 + 0.5) * hs, 4), round((c[1]) * vs, 4), round((c[2] + F * z0 + 0.5) * hs, 4)])
            c = prev[c]
        return path[::-1]

    def nearest_reached(px, py, pz, row):
        best, bd = None, 1e9
        for (cx, cy, cz) in prev:
            if cy != row:
                continue
            d = math.hypot((cx + F * x0 + 0.5) * hs - px, (cz + F * z0 + 0.5) * hs - pz)
            if d < bd:
                bd, best = d, (cx, cy, cz)
        return best, bd

    plan = b.detail.interior_plan
    routes, missing = [], []
    for pi, pp in enumerate(plan.parts):
        lv = pp['levels'][0]
        row = lv['slab_top'] + 1
        for ri, r in enumerate(lv['rooms']):
            if r['type'] in ('stairs', 'lift'):
                continue
            poly = r['poly_uv'].buffer(-0.25)
            if poly.is_empty:
                poly = r['poly_uv'].buffer(-0.1)
            if poly.is_empty:
                continue
            pt = poly.representative_point()
            E, N = walkcheck.plan_world(plan, (pt.x, pt.y))
            px, pz = E - g.e0, g.n0 - N
            cell, d = nearest_reached(px, row * vs, pz, row)
            label = f"part{pi}-room{ri}-{r['type']}"
            if cell is None or d > 1.2:
                missing.append(label)
            else:
                routes.append(dict(name=label, kind='room', path=route(cell)))
    top_row = fys[-1] + 1
    goal = next((c for c in prev if c[1] == top_row), None)
    if len(fys) > 1:
        if goal is None:
            missing.append('top-storey')
        else:
            routes.append(dict(name='top-storey', kind='top', path=route(goal)))
    rows = sorted({c[1] for c in prev})
    print('   rows reached', rows[0], '..', rows[-1], 'floor rows', [f + 1 for f in fys])
    json.dump(dict(unreachable=missing, routes=routes), open(f"{OUT}/{name}.routes.json", 'w'))
    print(name, 'levels', len(fys), 'voxels', len(X), 'routes', len(routes), 'unreachable', missing)


for name, coords, vs, kw in fixtures():
    build(name, coords, vs, kw)
