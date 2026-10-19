"""Walking demo: DetailStats.entrances (interior.compute_entrances + detail_scene._map_entrances).

Doorways are carved (interior.doorway_mask); `walkcheck.check_entrance` flood-fills a 1.8 m x 0.6 m walker
(0.2 m steps, no jumping) from outside to inside on the plain voxels."""
import math, os, sys, tempfile, unittest
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from voxelworlds.voxel import bindex, interior
from voxelworlds.voxel.grid import make_grid
from voxelworlds.voxel.vwg import read_vwg
from test_interior import make_building, run, rect
import test_detail_scene as tds
from test_detail_scene import BBOX, utm_records  # noqa
import walkcheck

L_SHAPE = [(0, 0), (16, 0), (16, 6), (7, 6), (7, 14), (0, 14)]


def rotated(coords, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return [(x * c - y * s, x * s + y * c) for x, y in coords]


def scene_of(b, g, xyz):
    """interior + exterior shell + roof + a ground plate at the building base (the detail scene is flat)."""
    zz, xx = np.meshgrid(np.arange(g.nz), np.arange(g.nx))
    plate = np.column_stack([xx.ravel(), np.full(xx.size, b.base_y), zz.ravel()])
    parts = [plate, np.column_stack([b.wx, b.wy, b.wz]), np.asarray(xyz, np.int64).reshape(-1, 3)]
    if len(b.rx):
        parts.append(np.column_stack([b.rx, b.ry, b.rz]))
    A = np.concatenate([np.asarray(p, np.int64) for p in parts])
    for e in (getattr(b.detail, "entrances_raw", None) or []):      # what detail_scene does after the interior
        A = A[~interior.doorway_mask(A[:, 0], A[:, 1], A[:, 2], e, g)]
    return A[:, 0], A[:, 1], A[:, 2]


def level0_rooms_reached(sw, b, g, plan):
    """-> list of unreachable level-0 rooms (non stairs/lift) and whether a stair room was reached."""
    missing, stairs_ok, has_stairs = [], True, False
    vs = g.vs
    for pi, pp in enumerate(plan.parts):
        lv = pp["levels"][0]
        y = lv["slab_top"] + 1
        for ri, r in enumerate(lv["rooms"]):
            poly = r["poly_uv"].buffer(-0.25)
            if poly.is_empty:
                poly = r["poly_uv"].buffer(-0.1)
            if poly.is_empty:
                continue
            u0, v0, u1, v1 = poly.bounds
            from shapely.geometry import Point
            hit = False
            for u in np.arange(u0, u1 + 1e-9, vs):
                for v in np.arange(v0, v1 + 1e-9, vs):
                    if not poly.contains(Point(u, v)):
                        continue
                    E, N = walkcheck.plan_world(plan, (u, v))
                    x, z = int(math.floor((E - g.e0) / vs)), int(math.floor((g.n0 - N) / vs))
                    ys = range(y, y + max(2, int(0.8 / vs))) if r["type"] == "stairs" else [y]
                    if any(sw.reached(x, yy, z) for yy in ys):
                        hit = True
                        break
                if hit:
                    break
            if r["type"] == "stairs":
                has_stairs = True
                stairs_ok = stairs_ok and hit
            elif r["type"] == "lift":
                continue
            elif not hit:
                missing.append((pi, ri, r["type"], round(r["poly_uv"].area, 1)))
    return missing, stairs_ok, has_stairs


class EntranceUnitTests(unittest.TestCase):
    def check_building(self, label, coords, vs, door="none", body="disc", storeys=True, **kw):
        kw.setdefault("levels", 2)
        kw.setdefault("height", 7.0)
        wall_t = 2 if door != "none" else 1
        b, g = make_building(coords, vs=vs, wall_t=wall_t, **kw)
        if door == "south":     # painted facade door on edge 0 (like a photo facade)
            zmax = int(b.wz.max())
            xs = sorted(set(b.wx[b.wz == zmax].tolist()))
            xm = (xs[0] + xs[-1]) // 2
            hw = int(round(0.55 / vs))
            b.detail.openings = [dict(edge=0, kind="door", x0=xm - hw, x1=xm + hw, z0=zmax - wall_t + 1, z1=zmax + 1,
                                      y0=b.base_y + 1, y1=b.base_y + int(round(2.0 / vs)))]
            b.detail.wall_t = wall_t
        xyz, codes, _ = run(b, g)
        raw = b.detail.entrances_raw
        self.assertGreaterEqual(len(raw), 1, f"{label}: no entrance")
        X, Y, Z = scene_of(b, g, xyz)
        plan = b.detail.interior_plan
        for k, e in enumerate(raw):
            sw = walkcheck.SceneWalk(X, Y, Z, vs, body=body)
            probs = walkcheck.check_entrance(sw, e)
            self.assertEqual(probs, [], f"{label} entrance {k}: {probs}")
            # distances from the door point on the outline (outside 0.6-1.0 m out, inside 0.5-1.6 m in)
            pt, n = np.array(e["pt"]), np.array(e["n_in"])
            ob = (np.array([e["outside"][0] + g.e0, g.n0 - e["outside"][2]]) - pt) @ n
            ib = (np.array([e["inside"][0] + g.e0, g.n0 - e["inside"][2]]) - pt) @ n
            self.assertTrue(-1.05 <= ob <= -0.5, f"{label}: outside at {ob:.2f}")
            self.assertTrue(0.5 <= ib <= 1.7, f"{label}: inside at {ib:.2f}")
            # the walk continues from the inside to every room / the stairs of the ground floor
            if k == 0:
                missing, _, _ = level0_rooms_reached(sw, b, g, plan)
                self.assertEqual(missing, [], f"{label}: rooms not reachable from the entrance")
                fys = b.detail.floor_ys_built
                for fy in (fys[1:] if storeys else []):      # the stairs lead up to every built storey (walker stands on its floor)
                    self.assertTrue(sw.seen[:, fy + 1, :].any(), f"{label}: storey at row {fy} not reachable")
        return b, raw

    def test_house_voxel_sizes(self):
        for vs in (0.1, 0.15, 0.25):
            self.check_building(f"house vs={vs}", rect(10, 8), vs)

    def test_l_shape(self):
        for vs in (0.15, 0.25):
            self.check_building(f"L vs={vs}", L_SHAPE, vs)

    def test_rotated(self):
        for deg in (33, 90, 135):
            # rotated layouts are jagged diagonals: every room must still be reachable for the client's 0.6 m disc
            self.check_building(f"rot {deg}", rotated(rect(14, 9), deg), 0.15, storeys=False)   # stairs: StairTests (Mover)

    def test_rotated_offices_and_houses_are_enterable_by_a_disc(self):
        """the fixtures of tests/walk-real-interior.test.ts: offices and houses rotated 33 / 135 degrees at 0.15 and 0.2 m"""
        for vs in (0.15, 0.2):
            for deg in (33, 135):
                self.check_building(f"office r{deg} vs={vs}", rotated(rect(26, 13), deg), vs, storeys=False,
                                    kind="commercial", btype="office", levels=3, height=10.6)
                self.check_building(f"house r{deg} vs={vs}", rotated(rect(14, 9), deg), vs, storeys=False,
                                    levels=3, height=10.6)

    def test_unreachable_rooms_trigger_repairs_then_a_warning(self):
        """generator-level validation: wider doors (3 rounds), then no furniture, then ROOM_UNREACHABLE; never silent"""
        from unittest import mock
        calls = []

        def always_bad(self, xyz, plan_levels):
            calls.append((self.door_extra, self.no_fix))
            return [(0, 0, 1)]
        with mock.patch.object(interior._Builder, "_unreachable_rooms", always_bad):
            b, g = make_building(rect(10, 8), vs=0.15, levels=2, height=7.0)
            xyz, _, _ = run(b, g)
        self.assertEqual([c[0] for c in calls], [0.0, 0.2, 0.4, 0.6, 0.6])
        self.assertEqual([c[1] for c in calls], [False, False, False, False, True])
        self.assertIn("ROOM_UNREACHABLE", [w[0] for w in b.detail.warnings])
        self.assertGreater(len(xyz), 1000)
        # deterministic
        with mock.patch.object(interior._Builder, "_unreachable_rooms", always_bad):
            b2, g2 = make_building(rect(10, 8), vs=0.15, levels=2, height=7.0)
            xyz2, _, _ = run(b2, g2)
        self.assertEqual(xyz.tobytes(), xyz2.tobytes())

    def test_the_u_stair_has_a_wall_between_its_lanes(self):
        b, g = make_building(rect(10, 8), vs=0.15, levels=3, height=10.6)
        xyz, codes, _ = run(b, g)
        sp = b.detail.interior_plan.parts[0]["specs"][0]
        self.assertEqual(sp["kind"], "U")
        X, Y, Z = scene_of(b, g, xyz)
        sw = walkcheck.SceneWalk(X, Y, Z, 0.15, build_s=False)
        plan = b.detail.interior_plan
        o, ea, eb = sp["o"], sp["ea"], sp["eb"]
        fy = plan.floor_ys
        a = sp["La"] / 2
        E, N = walkcheck.plan_world(plan, (o[0] + ea[0] * a + eb[0] * sp["sw"], o[1] + ea[1] * a + eb[1] * sp["sw"]))
        x, z = int((E - g.e0) / 0.15) - sw.x0, int((g.n0 - N) / 0.15) - sw.z0
        # solid over the whole height of the first storey, right on the lane boundary
        self.assertTrue(sw.occ[x, fy[0] + 1: fy[1] - 1, z].all())

    def test_painted_facade_door(self):
        for vs in (0.1, 0.15, 0.25):
            b, raw = self.check_building(f"door vs={vs}", rect(12, 8), vs, door="south")
            self.assertEqual(b.detail.doors_added, 0)
            self.assertEqual(len(raw), 1)
            self.assertEqual(raw[0]["kind"], "openings")
            self.assertGreaterEqual(raw[0]["widthM"], 0.9)

    def test_other_building_types(self):
        self.check_building("office", rect(30, 14), 0.25, kind="commercial", btype="office", levels=3, height=10.5)
        self.check_building("shop", rect(12, 8), 0.15, kind="commercial", btype="retail", levels=1, height=4.5)
        self.check_building("hall", rect(24, 14), 0.25, kind="industrial", btype="warehouse", levels=1, height=7.0)
        self.check_building("church", rect(30, 12), 0.25, kind="religious", btype="church", levels=1, height=9.0)

    def test_court_footprint_edge_cases_never_crash(self):
        # a hollow footprint and a tiny one: entrances may be empty but nothing raises
        hole = [(4, 3), (10, 3), (10, 9), (4, 9)]
        b, g = make_building(rect(14, 12), vs=0.25, holes=[hole], levels=2, height=7.0)
        run(b, g)
        self.assertIsInstance(b.detail.entrances_raw, list)
        b, g = make_building(rect(2, 2), vs=0.25, levels=1, height=3.0)
        run(b, g)
        self.assertIsInstance(b.detail.entrances_raw, list)

    def test_deterministic_and_json_safe(self):
        import json
        outs = []
        for _ in range(2):
            b, g = make_building(rect(10, 8), vs=0.15, levels=2, height=7.0)
            run(b, g, seed=5)
            outs.append(json.dumps(b.detail.entrances_raw, sort_keys=True))
        self.assertEqual(outs[0], outs[1])


class StairTests(unittest.TestCase):
    """Stairs must be climbable by the client's walker (src/renderer/walk/physics.ts ported in walkcheck.Mover:
    swept 0.6 x 1.8 m box, step-up 0.25 m, no jump) with >= 2.5 m of vertical head room above every tread."""

    def check(self, label, coords, vs, **kw):
        b, g = make_building(coords, vs=vs, **kw)
        xyz, codes, _ = run(b, g)
        if b.detail.levels_built < 2:
            return None
        X, Y, Z = scene_of(b, g, xyz)
        free = walkcheck.stair_headroom(b, g, X, Y, Z, xyz, codes)
        need = int(math.ceil(interior.STAIR_HEAD / vs - 1e-9))
        self.assertGreaterEqual(free, need, f"{label}: only {free * vs:.2f} m above a tread")
        self.assertEqual(walkcheck.climb_all_flights(b, g, X, Y, Z), [], label)
        for pp in b.detail.interior_plan.parts:
            for sp in pp["specs"]:
                self.assertGreaterEqual(sp["sw"], 1.0)
        return free * vs

    def test_flights_climbable_all_voxel_sizes_and_storey_heights(self):
        seen = []
        for vs in (0.1, 0.15, 0.2, 0.25):
            for sh in (2.9, 3.5):
                for name, co, kw in (("house", rect(10, 8), dict(levels=3)),
                                     ("L", L_SHAPE, dict(levels=4)),
                                     ("office", rect(30, 14), dict(levels=3, kind="commercial", btype="office"))):
                    h = self.check(f"{name} vs={vs} storey={sh}", co, vs, height=kw["levels"] * sh + 0.1,
                                   **kw)
                    seen.append(h)
        self.assertGreaterEqual(len([h for h in seen if h]), 15)       # most fixtures really are multi-storey

    def test_rotated_stairs(self):
        for deg in (33, 90, 135):
            self.check(f"rot {deg}", rotated(rect(14, 9), deg), 0.15, levels=3, height=10.6)

    def test_low_storeys_build_fewer_levels_instead_of_unclimbable_stairs(self):
        b, g = make_building(rect(10, 8), vs=0.2, levels=3, height=7.6)      # 2.5 m storeys
        run(b, g)
        self.assertEqual(b.detail.levels_built, 1)
        self.assertGreaterEqual(interior.min_storey_rows(0.2) * 0.2, interior.STAIR_HEAD)


class DoorwayGuardTests(unittest.TestCase):
    def test_avoid_geometry_keeps_foreign_voxels(self):
        from shapely.geometry import box
        b, g = make_building(rect(10, 8), vs=0.15, levels=2, height=7.0)
        xyz, codes, _ = run(b, g)
        e = b.detail.entrances_raw[0]
        b.detail.entrances_raw = []          # the scene as it is before the doorways are carved
        X, Y, Z = scene_of(b, g, xyz)
        A = np.column_stack([X, Y, Z])
        free = interior.doorway_mask(A[:, 0], A[:, 1], A[:, 2], e, g)
        self.assertTrue(free.any())
        E = g.e0 + (A[free, 0] + 0.5) * g.vs
        N = g.n0 - (A[free, 2] + 0.5) * g.vs
        # a 'neighbour' covering the near half of the outline side of the lane
        half = box(e["pt"][0] - 5, e["pt"][1] - 5, e["pt"][0] + 5, e["pt"][1] + 5)
        kept = interior.doorway_mask(A[:, 0], A[:, 1], A[:, 2], e, g, half)
        self.assertEqual(int(kept.sum()), 0)       # everything of the lane lies inside that box: nothing is carved
        other = box(e["pt"][0] + 100, e["pt"][1], e["pt"][0] + 101, e["pt"][1] + 1)
        self.assertEqual(int(interior.doorway_mask(A[:, 0], A[:, 1], A[:, 2], e, g, other).sum()), int(free.sum()))

    def test_neighbour_shells_are_not_carved(self):
        from unittest import mock
        res = {}
        for carve in (True, False):
            ctx = (mock.patch.object(interior, "doorway_mask", lambda X, Y, Z, e, g, avoid=None: np.zeros(len(X), bool))
                   if not carve else mock.patch.object(interior, "_noop", create=True))
            with ctx:
                r, _ = EntranceDetailTests.run_detail(EntranceDetailTests, "way/102", vs=0.25, facade=False,
                                                     interior=dict(enabled=True), includeNeighbours=True)
            res[carve] = read_vwg(r["vwgPath"])
        # neighbour voxels (outside the target footprint + 1 m) are identical with and without carving
        from voxelworlds.voxel.vwg import read_vwg as _r
        h0, X0, Y0, Z0, C0 = res[False]
        h1, X1, Y1, Z1, C1 = res[True]
        k0 = set(zip(X0.tolist(), Y0.tolist(), Z0.tolist()))
        k1 = set(zip(X1.tolist(), Y1.tolist(), Z1.tolist()))
        gone = k0 - k1
        self.assertTrue(gone and k1 <= k0)
        # way/101 and way/103 are 'others': none of the removed voxels may sit in their footprints
        from test_detail_scene import utm_records
        from shapely.geometry import Point
        grid, bs, recs = utm_records()
        o = h0["origin"]
        for rc in recs:
            if rc["key"].startswith("way/102"):
                continue
            for (x, y, z) in gone:
                self.assertFalse(rc["poly"].contains(Point(o["easting"] + (x + .5) * 0.25, o["northing"] - (z + .5) * 0.25)))


class EntranceDetailTests(unittest.TestCase):
    SPEC = tds.DetailTests.SPEC
    run_detail = tds.DetailTests.run_detail
    """run_detail end to end on the synthetic extract; voxels from the written .vwg."""
    KEYS = {"edge", "city", "cityDir", "inside", "outside", "dir", "widthM"}

    def vwg_scene(self, r, vs):
        h, X, Y, Z, C = read_vwg(r["vwgPath"])
        return h, X, Y, Z

    def test_entrances_end_to_end(self):
        for bid in ("way/101", "way/102", "way/103", "relation/7"):
            for vs in (0.15, 0.25):
                for facade in (True, False):
                    r, sink = self.run_detail(bid, vs=vs, facade=facade, interior=dict(enabled=True))
                    ents = r["stats"].get("entrances")
                    self.assertIsInstance(ents, list, bid)
                    label = f"{bid} vs={vs} facade={facade}"
                    self.assertGreaterEqual(len(ents), 1, label)      # narrow facade doors are widened, not dropped
                    h, X, Y, Z = self.vwg_scene(r, vs)
                    for e in ents:
                        self.assertEqual(set(e), self.KEYS)
                        self.assertIsInstance(e["edge"], int)
                        self.assertTrue(all(isinstance(v, int) for v in e["city"]))
                        self.assertAlmostEqual(math.hypot(*e["cityDir"]), 1.0, places=2)
                        self.assertAlmostEqual(e["cityDir"][0], -e["dir"][0], places=3)
                        self.assertAlmostEqual(e["cityDir"][1], -e["dir"][1], places=3)
                        self.assertGreaterEqual(e["widthM"], 0.9)
                        sw = walkcheck.SceneWalk(X, Y, Z, vs)
                        self.assertEqual(walkcheck.check_entrance(sw, e), [], label)

    def test_city_cell_is_outside_the_footprint_in_front_of_the_door(self):
        r, _ = self.run_detail("way/102", vs=0.15, facade=False, interior=dict(enabled=True),
                               ref_extra=dict(cityVoxelSize=1.0, cityBaseY=7))
        h = read_vwg(r["vwgPath"])[0]
        cg, _ = make_grid(BBOX, 1.0)
        from test_detail_scene import utm_records
        _, _, recs = utm_records()
        poly = next(rc["poly"] for rc in recs if rc["key"].startswith("way/102"))
        for e in r["stats"]["entrances"]:
            self.assertEqual(e["city"][1], 7)
            ce = cg.e0 + (e["city"][0] + 0.5)
            cn = cg.n0 - (e["city"][2] + 0.5)
            from shapely.geometry import Point
            self.assertFalse(poly.contains(Point(ce, cn)))
            oe = h["origin"]["easting"] + e["outside"][0]
            on = h["origin"]["northing"] - e["outside"][2]
            self.assertLess(math.hypot(ce - oe, cn - on), 2.6)
            # the building lies behind the door: from the city cell the door is towards -cityDir
            self.assertLess((oe - ce) * e["cityDir"][0] + (-(on - cn)) * e["cityDir"][1] + 1e-9, 1.0)

    def test_entrances_do_not_change_the_voxels(self):
        r1, _ = self.run_detail("way/101", interior=dict(enabled=True))
        r2, s2 = self.run_detail("way/101", interior=dict(enabled=True), ref_extra={})
        self.assertIn("entrances", r1["stats"])
        self.assertNotIn("entrances", r2["stats"])      # city frame unknown -> absent + warning
        self.assertIn("ENTRANCE_CITY_UNKNOWN", [e.get("code") for e in s2.ev])
        a, b = read_vwg(r1["vwgPath"]), read_vwg(r2["vwgPath"])
        for x, y in zip(a[1:], b[1:]):
            np.testing.assert_array_equal(x, y)
        self.assertEqual(a[0]["palette"], b[0]["palette"])

    def test_only_door_cells_differ_from_the_uncarved_scene(self):
        from unittest import mock
        for facade in (True, False):
            for vs in (0.15, 0.25):
                with mock.patch.object(interior, "doorway_mask", lambda X, Y, Z, e, g, avoid=None: np.zeros(len(X), bool)):
                    r0, _ = self.run_detail("way/102", vs=vs, facade=facade, interior=dict(enabled=True))
                r1, _ = self.run_detail("way/102", vs=vs, facade=facade, interior=dict(enabled=True))
                h0, X0, Y0, Z0, C0 = read_vwg(r0["vwgPath"])
                h1, X1, Y1, Z1, C1 = read_vwg(r1["vwgPath"])
                k0 = (X0.astype(np.int64) * 10_000_000 + Z0) * 100_000 + Y0
                k1 = (X1.astype(np.int64) * 10_000_000 + Z1) * 100_000 + Y1
                self.assertTrue(np.isin(k1, k0).all(), "carving must not add voxels")
                gone = ~np.isin(k0, k1)
                self.assertGreater(int(gone.sum()), 0)
                from voxelworlds.voxel.grid import Grid
                o = h0["origin"]
                g = Grid(o["epsg"], o["utmZone"], o["hemisphere"], o["easting"], o["northing"], vs, 1, 1)
                # re-derive the lane of every entrance from the stats: inside/outside points + widthM
                inside = np.zeros(len(X0), bool)
                for e in r1["stats"]["entrances"]:
                    ix, iz = np.array(e["inside"])[[0, 2]], np.array(e["outside"])[[0, 2]]
                    d = np.array(e["dir"])
                    tdir = np.array([-d[1], d[0]])
                    px = (X0 + 0.5) * vs; pz = (Z0 + 0.5) * vs
                    de = (px - iz[0]) * d[0] + (pz - iz[1]) * d[1]
                    al = (px - iz[0]) * tdir[0] + (pz - iz[1]) * tdir[1]
                    L = float(np.hypot(*(ix - iz)))
                    inside |= (np.abs(al) <= 0.5 * e["widthM"] + 0.5 * vs + 0.2) & (de >= -0.5 * vs - 1.4) & (de <= L + 0.5 * vs + 0.4) \
                        & (Y0 >= round(e["inside"][1] / vs)) & (Y0 < round(e["inside"][1] / vs) + int(np.ceil(2.0 / vs)))
                self.assertTrue(inside[gone].all(), "a voxel outside the doorway changed")
                self.assertEqual(r0["stats"]["voxelCount"] - r1["stats"]["voxelCount"], int(gone.sum()))

    def test_walk_door_to_top_storey_with_the_clients_mover(self):
        """the whole route from the entrance to the highest floor (flight to flight, turns, landings) on the written
        scene, driven by hold-W style steering with the port of the client's Mover (tests/walk-real-interior.test.ts
        does the same with the real physics.ts on fixtures from scripts/walk-interior-fixture.py)."""
        for bid in ("way/101", "way/103", "relation/7"):
            for vs in (0.15, 0.2, 0.25):
                r, _ = self.run_detail(bid, vs=vs, facade=False, interior=dict(enabled=True))
                h, X, Y, Z, C = read_vwg(r["vwgPath"])
                e = r["stats"]["entrances"][0]
                sw = walkcheck.SceneWalk(X, Y, Z, vs)
                start = (int(math.floor(e["inside"][0] / vs)), int(round(e["inside"][1] / vs)),
                         int(math.floor(e["inside"][2] / vs)))
                path = walkcheck.bfs_route(sw, start, r["stats"]["floorYs"][-1] + 1)
                label = f"{bid} vs={vs}"
                self.assertIsNotNone(path, f"{label}: no 0.6 m box route to the top storey")
                ok, maxy = walkcheck.drive_route(sw, path)
                self.assertTrue(ok, f"{label}: the Mover got only to y={maxy:.2f} of {path[-1][1]:.2f}")

    def test_stairs_climbable_in_the_written_scene(self):
        """multi-storey detail scenes (Zurich style: 0.15 / 0.2 m, apartments, with and without a photo facade): the
        client's walker climbs every flight on the voxels of the written .vwg."""
        from unittest import mock
        grabbed = []
        real = interior.build_interior

        def spy(b, opts, grid, rng):
            out = real(b, opts, grid, rng)
            grabbed.append((b, grid))
            return out
        for bid in ("way/101", "way/103", "relation/7"):
            for vs in (0.15, 0.2):
                for facade in (False, True):
                    grabbed.clear()
                    with mock.patch.object(interior, "build_interior", spy):
                        r, _ = self.run_detail(bid, vs=vs, facade=facade, interior=dict(enabled=True))
                    b, g = grabbed[0]
                    label = f"{bid} vs={vs} facade={facade}"
                    h, X, Y, Z, C = read_vwg(r["vwgPath"])
                    self.assertGreater(r["stats"]["levels"], 1, label)
                    self.assertEqual(walkcheck.climb_all_flights(b, g, X, Y, Z), [], label)

    def test_no_interior_has_no_entrances(self):
        r, _ = self.run_detail("way/101", facade=False)
        self.assertNotIn("entrances", r["stats"])

    def test_city_info_from_the_generate_cache(self):
        d = tempfile.mkdtemp()
        os.environ["VOXEL_CACHE_DIR"] = d
        idx = {"version": 1, "buildings": [{"id": "way/102", "baseY": 5}]}
        bindex.remember_city(BBOX, 2.0, idx)
        self.assertEqual(bindex.lookup_city(BBOX, 2.0, "way/102"), (2.0, 5))
        self.assertEqual(bindex.lookup_city(BBOX, None, "way/102"), (2.0, 5))
        self.assertIsNone(bindex.lookup_city(BBOX, 3.0, "way/102"))
        self.assertIsNone(bindex.lookup_city(BBOX, None, "way/999"))
