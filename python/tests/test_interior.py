"""Procedural interiors (voxel/interior.py): synthetic footprints on a local grid, no network."""
import math, os, sys, time, types, unittest, unittest.mock
from types import SimpleNamespace
import numpy as np
from shapely.geometry import Polygon, Point
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from voxelworlds.config import DEFAULT_CONFIG as cfg
from voxelworlds.protocol import Cancelled, PipelineError
from voxelworlds.voxel import interior
from voxelworlds.voxel.buildings import Building, voxelize_building
from voxelworlds.voxel.grid import Grid
import walkcheck

E0, N0 = 500000.0, 5250000.0


def make_building(coords, vs=0.15, height=10.5, levels=3, kind="residential", btype="house", holes=None,
                  openings=None, wall_t=1, key="way/1", max_voxels=None, check=None):
    """Voxelised exterior (real voxelize_building) + the `detail` namespace detail_scene would attach."""
    poly = Polygon([(E0 + x, N0 + y) for x, y in coords],
                   [[(E0 + x, N0 + y) for x, y in h] for h in (holes or [])])
    minx, miny, maxx, maxy = poly.bounds
    gx0, gx1 = math.floor((minx - 3) / vs), math.ceil((maxx + 3) / vs)
    gy0, gy1 = math.floor((miny - 3) / vs), math.ceil((maxy + 3) / vs)
    grid = Grid(32632, 32, "N", gx0 * vs, gy1 * vs, vs, gx1 - gx0, gy1 - gy0)
    b = Building(key=key, poly=poly, height_m=height, min_height_m=0.0, kind=kind, wall_tag=None, roof_tag=None,
                 btype=btype)
    voxelize_building(b, grid, None, cfg)
    hv = (int(b.eave_y) - b.base_y - 1) / float(levels)
    fy = [int(b.base_y + round(k * hv)) for k in range(levels)]
    b.detail = SimpleNamespace(levels=levels, level_h_vox=hv, floor_ys=fy, members=[b], openings=list(openings or []),
                               wall_t=wall_t, rooms=0, check=check, max_voxels=max_voxels, warnings=[], doors_added=0)
    return b, grid


def run(b, grid, opts=None, seed=7):
    t0 = time.time()
    xyz, codes = interior.build_interior(b, dict(enabled=True, **(opts or {})), grid, np.random.default_rng(seed))
    return xyz, codes, time.time() - t0


def rect(w, h, x=0.0, y=0.0):
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]


DOOR_MAX = 1.3


class InteriorTests(unittest.TestCase):
    VS = 0.15

    def house(self, **kw):
        kw.setdefault("levels", 2)
        kw.setdefault("height", 7.0)
        b, g = make_building(rect(10, 8), **kw)
        return b, g

    # -- basics
    def test_house_basic_and_stats(self):
        b, g = self.house()
        xyz, codes, dt = run(b, g)
        self.assertEqual(xyz.dtype, np.int32)
        self.assertEqual(codes.dtype, np.uint32)
        self.assertEqual(len(xyz), len(codes))
        self.assertGreater(len(xyz), 5000)
        self.assertGreaterEqual(b.detail.rooms, 4)
        self.assertTrue((xyz[:, 0] >= 0).all() and (xyz[:, 0] < g.nx).all())
        self.assertTrue((xyz[:, 2] >= 0).all() and (xyz[:, 2] < g.nz).all())
        # unique
        k = (xyz[:, 0].astype(np.int64) * (g.nz + 1) + xyz[:, 2]) * 4096 + xyz[:, 1]
        self.assertEqual(len(np.unique(k)), len(k))
        # slab voxels present at every floor_y (one row at floor_ys[k]) and none above the roof
        ys = set(np.unique(xyz[:, 1]).tolist())
        for fy in b.detail.floor_ys:
            self.assertIn(fy, ys)
        self.assertLess(xyz[:, 1].max(), b.eave_y)
        # materials only wall / other
        mats = set((codes & 7).tolist())
        self.assertTrue(mats <= {interior.MW, interior.MO})

    def test_determinism_byte_identical(self):
        b, g = self.house()
        a = run(b, g, seed=5)
        b2, g2 = self.house()
        c = run(b2, g2, seed=5)
        self.assertEqual(a[0].tobytes(), c[0].tobytes())
        self.assertEqual(a[1].tobytes(), c[1].tobytes())
        b3, g3 = self.house()
        d = run(b3, g3, seed=6)
        self.assertNotEqual(a[1].tobytes() + a[0].tobytes(), d[1].tobytes() + d[0].tobytes())

    def test_rooms_reachable_door_graph(self):
        for coords, kw in [(rect(10, 8), {}), (rect(30, 14), dict(kind="commercial", btype="office", levels=3)),
                           ([(0, 0), (16, 0), (16, 6), (7, 6), (7, 14), (0, 14)], dict(levels=2))]:
            b, g = make_building(coords, **{**dict(levels=2, height=7.0), **kw})
            run(b, g)
            plan = b.detail.interior_plan
            for part in plan.parts:
                for lv in part["levels"]:
                    n = len(lv["rooms"])
                    adj = {i: set() for i in range(n)}
                    for (i, j, c) in lv["doors"]:
                        adj[i].add(j); adj[j].add(i)
                    for (i, j) in lv["links"]:      # open stair aprons
                        adj[i].add(j); adj[j].add(i)
                    seen = {lv["entrance_room"]}
                    st = [lv["entrance_room"]]
                    while st:
                        u = st.pop()
                        for v in adj[u]:
                            if v not in seen:
                                seen.add(v); st.append(v)
                    self.assertEqual(len(seen), n, f"unreachable rooms on level {lv['level']}")

    def test_stairs_connect_all_floors(self):
        b, g = self.house(levels=3, height=10.5)
        xyz, codes, _ = run(b, g)
        plan = b.detail.interior_plan
        spec = plan.parts[0]["spec"]
        self.assertIsNotNone(spec)
        fy = b.detail.floor_ys
        vs = g.vs
        # every row between two floors carries a tread, and a tread never rises more than one riser from its neighbour
        want = (interior.C_STAIR[0] << 16 | interior.C_STAIR[1] << 8 | interior.C_STAIR[2]) << 3 | interior.MW
        ys = set(xyz[codes == want][:, 1].tolist())
        for k in range(len(fy) - 1):
            for y in range(fy[k] + 1, fy[k + 1] + 1):
                self.assertIn(y, ys, f"no step at row {y} between floors {k}->{k + 1}")
        w = walkcheck.Walk(b, g, xyz)
        st = walkcheck.start_cell(w, plan, plan.parts[0])
        self.assertIsNotNone(st, "no standable cell behind the entrance door")
        self.assertGreater(w.fill(st), 500)
        top = fy[-1] + 1
        self.assertTrue(w.seen[:, top, :].any(), "top storey not reachable by walking")
        # the climb really goes through every height in between (no teleport through the slab)
        for y in range(1, top + 1):
            self.assertTrue(w.seen[:, y, :].any(), f"walker never stands at row {y}")

    def test_every_room_reachable_by_walking(self):
        b, g = self.house(levels=2, height=7.0)
        xyz, codes, _ = run(b, g)
        r = walkcheck.analyse(b, g, xyz)
        self.assertTrue(r["start_ok"])
        self.assertEqual(r["missing_rooms"], [])
        self.assertEqual(r["missing_levels"], [])

    def assert_walkable(self, b, g, xyz, label=""):
        r = walkcheck.analyse(b, g, xyz)
        self.assertEqual(r["plan"], None, label)
        self.assertTrue(r["start_ok"], f"{label}: cell behind the entrance door is not standable")
        self.assertEqual(r["missing_levels"], [], label)
        self.assertEqual(r["missing_rooms"], [], label)
        plan = b.detail.interior_plan
        for pp in plan.parts:
            for lv in pp["levels"]:
                rs = lv["rooms"]
                for i in range(len(rs)):
                    for j in range(i + 1, len(rs)):
                        self.assertLess(rs[i]["poly_uv"].intersection(rs[j]["poly_uv"]).area, 1e-3,
                                        f"{label}: rooms {i}/{j} overlap on level {lv['level']}")
                self.assertEqual(lv["unreachable"], [], label)
        return r

    def test_walk_matrix(self):
        """flood fill from behind the entrance door must reach every room of every storey (no ground shortcut)"""
        sizes = [(6, 5), (7, 3.5), (10, 8), (20, 10), (30, 14)]
        kinds = [("residential", "house"), ("commercial", "office"), ("commercial", "retail"), ("generic", "yes")]
        n = 0
        for (w, h) in sizes:
            for vs in (0.1, 0.15, 0.2, 0.25):
                for lv in (1, 2, 3, 7):
                    for kind, bt in kinds:
                        b, g = make_building(rect(w, h), vs=vs, levels=lv, height=lv * 3.0 + 0.5, kind=kind, btype=bt)
                        xyz, codes, _ = run(b, g)
                        self.assert_walkable(b, g, xyz, f"{w}x{h} vs{vs} L{lv} {kind}/{bt}")
                        n += 1
        self.assertEqual(n, 320)

    def test_walk_other_shapes(self):
        L = [(0, 0), (16, 0), (16, 6), (7, 6), (7, 14), (0, 14)]
        b, g = make_building(L, levels=3, height=10.5)
        xyz, _, _ = run(b, g)
        self.assert_walkable(b, g, xyz, "L shape")
        a = math.radians(33)
        c, s_ = math.cos(a), math.sin(a)
        pts = [(x * c - y * s_, x * s_ + y * c) for x, y in rect(14, 9)]
        b, g = make_building(pts, levels=3, height=10.5)
        xyz, _, _ = run(b, g)
        self.assert_walkable(b, g, xyz, "33 degrees")
        b, g = make_building(rect(30, 24), holes=[rect(10, 8, 10, 8)], levels=3, height=10.5, vs=0.25)
        xyz, _, _ = run(b, g)
        self.assert_walkable(b, g, xyz, "courtyard")
        b, g = make_building(rect(60, 40), holes=[rect(26, 16, 17, 12)], levels=4, height=14.0, vs=0.25,
                             kind="commercial", btype="office")
        xyz, _, _ = run(b, g)
        self.assert_walkable(b, g, xyz, "large block")

    def test_low_storeys_keep_stairs_walkable(self):
        """regression (Metropol wings): 8 storeys of 2.2 m at 0.15 m: stacked flights must leave head room + one riser"""
        for (w, h) in ((20, 10), (30, 14), (22, 12)):
            b, g = make_building(rect(w, h), vs=0.15, levels=8, height=18.0, kind="commercial", btype="office")
            xyz, _, _ = run(b, g)
            self.assert_walkable(b, g, xyz, f"{w}x{h} 8 low storeys")

    def test_lift_above_five_levels(self):
        for (w, h), vs in (((10, 8), 0.2), ((20, 10), 0.15), ((30, 14), 0.25), ((10, 8), 0.1)):
            for kind, bt in (("residential", "house"), ("commercial", "office")):
                b, g = make_building(rect(w, h), vs=vs, levels=7, height=24.5, kind=kind, btype=bt)
                xyz, _, _ = run(b, g)
                label = f"{w}x{h} vs{vs} {kind}"
                self.assert_walkable(b, g, xyz, label)
                plan = b.detail.interior_plan
                codes_w = [x[0] for x in b.detail.warnings]
                lifts = [(lv["level"], i) for lv in plan.parts[0]["levels"] for i, r in enumerate(lv["rooms"])
                         if r["type"] == "lift"]
                if "INTERIOR_NO_LIFT" in codes_w:
                    self.assertEqual(lifts, [], label)
                    continue
                self.assertEqual(len(lifts), 7, label)
                for lv in plan.parts[0]["levels"]:
                    li = [i for i, r in enumerate(lv["rooms"]) if r["type"] == "lift"][0]
                    doors = [d for d in lv["doors"] if li in (d[0], d[1])]
                    self.assertEqual(len(doors), 1, f"{label}: lift needs exactly one door on level {lv['level']}")
                    other = doors[0][0] if doors[0][1] == li else doors[0][1]
                    self.assertTrue(lv["rooms"][other]["circ"], f"{label}: lift door must open onto circulation")

    def test_lift_dropped_with_warning_when_it_cannot_get_a_door(self):
        b, g = make_building(rect(6, 5), levels=7, height=24.5)
        run(b, g)
        self.assertIn("INTERIOR_NO_LIFT", [w[0] for w in b.detail.warnings])
        self.assertFalse(any(r["type"] == "lift" for lv in b.detail.interior_plan.parts[0]["levels"] for r in lv["rooms"]))

    def test_entrance_never_inside_stair_body(self):
        from shapely.geometry import box as sbox
        for (w, h) in ((6, 5), (7, 3.5), (10, 8), (20, 10)):
            for vs in (0.1, 0.15, 0.2, 0.25):
                b, g = make_building(rect(w, h), vs=vs, levels=3, height=10.5)
                run(b, g)
                pp = b.detail.interior_plan.parts[0]
                ep = Point(*pp["ent_in"])
                for sp in pp["specs"]:
                    self.assertFalse(sbox(*sp["body"]).buffer(0.2).contains(ep), f"{w}x{h} vs{vs}")

    def test_geos_failure_degrades_one_feature(self):
        import shapely
        # the historic crash: 10x8 residential, 7 levels, vs 0.15, seed 7 -> GEOS 'Clipping rectangle must be non-empty'
        b, g = make_building(rect(10, 8), vs=0.15, levels=7, height=24.5)
        xyz, _, _ = run(b, g, seed=7)
        self.assertGreater(len(xyz), 10000)
        self.assertGreaterEqual(b.detail.rooms, 7)
        # and when GEOS does fail inside shared(), the interior still exists
        real = shapely.clip_by_rect

        def boom(geom, *a, **k):
            raise shapely.errors.GEOSException("Clipping rectangle must be non-empty")
        b, g = make_building(rect(10, 8), vs=0.15, levels=3, height=10.5)
        with unittest.mock.patch.object(shapely, "clip_by_rect", boom):
            xyz, _, _ = run(b, g, seed=7)
        self.assertGreater(len(xyz), 5000)
        self.assertGreaterEqual(b.detail.rooms, 1)
        # degenerate zero-height segment really reaches the clip with a non-empty rectangle now
        from shapely.geometry import box as sbox
        bd = interior._Builder.shared
        dummy = SimpleNamespace()
        self.assertEqual(bd(dummy, sbox(0, 0, 4, 3), sbox(4, 0, 8, 3))[0][0][0], 4.0)

    def test_connect_forces_a_door_never_ships_sealed_rooms_silently(self):
        from shapely.geometry import box as sbox
        b, g = make_building(rect(14, 4), levels=1, height=3.5)
        run(b, g)
        bld = interior._Builder(b, dict(enabled=True), g, np.random.default_rng(1))
        bld.warnings = []
        # hall | room | room joined by a 0.6 m wall only (no regular 1.3 m door site) | a room that touches nothing
        rooms = [dict(poly=sbox(0, 0, 4, 4), circ=True, type="corridor"),
                 dict(poly=sbox(4, 0, 8, 4), circ=False, type="room"),
                 dict(poly=sbox(8, 0, 12, 0.6 + 0.0), circ=False, type="room", fixed=True),
                 dict(poly=sbox(20, 20, 24, 24), circ=False, type="room", fixed=True)]
        res = bld.connect(rooms, (1.0, 1.0), None, None)
        # the room behind the 0.6 m wall is merged into its neighbour (no sealed room), the isolated one is dropped
        # WITH a warning; whatever is left is reachable by doors
        self.assertEqual(res["unreachable"], [])
        self.assertEqual(len(res["rooms"]), 2)
        self.assertIn("INTERIOR_SIMPLIFIED", [w[0] for w in bld.warnings])
        self.assertEqual(len(res["doors"]), 1)
        # a room that only a stair body touches cannot get a door: it must be reported as unreachable
        bld.warnings = []
        rooms = [dict(poly=sbox(0, 0, 4, 4), circ=True, type="corridor"),
                 dict(poly=sbox(4, 0, 6, 4), circ=False, type="stairs"),
                 dict(poly=sbox(6, 0, 10, 4), circ=False, type="room", fixed=True)]
        res = bld.connect(rooms, (1.0, 1.0), sbox(4, 0, 6, 4), None)
        self.assertTrue(bld.warnings)
        self.assertTrue(all(i not in res["unreachable"] for i, r in enumerate(res["rooms"]) if r["type"] == "room"))

    def test_no_voxels_in_window_boxes(self):
        vs = 0.15
        # 12 x 8 m building, painted south wall (edge 0 of the CCW ring) with two windows and a door
        b, g = make_building(rect(12, 8), vs=vs, levels=2, height=7.0, wall_t=2)
        base = b.base_y
        # south wall is the minimum-N edge -> max iz; find its cells
        zmax = int(b.wz.max())
        xs = sorted(set(b.wx[b.wz == zmax].tolist()))
        x_mid = (xs[0] + xs[-1]) // 2
        op = []
        for xc in (x_mid - 25, x_mid + 25):
            op.append(dict(edge=0, kind="window", x0=xc - 4, x1=xc + 4, z0=zmax - 1, z1=zmax + 1, y0=base + 14, y1=base + 24))
            op.append(dict(edge=0, kind="window", x0=xc - 4, x1=xc + 4, z0=zmax - 1, z1=zmax + 1, y0=base + 14 + 24, y1=base + 24 + 24))
        op.append(dict(edge=0, kind="door", x0=x_mid - 3, x1=x_mid + 3, z0=zmax - 1, z1=zmax + 1, y0=base + 1, y1=base + 14))
        b.detail.openings = op
        b.detail.wall_t = 2
        xyz, codes, _ = run(b, g)
        for o in op:
            m = ((xyz[:, 0] >= o["x0"]) & (xyz[:, 0] < o["x1"]) & (xyz[:, 2] >= o["z0"]) & (xyz[:, 2] < o["z1"]) &
                 (xyz[:, 1] >= o["y0"]) & (xyz[:, 1] < o["y1"]))
            self.assertEqual(int(m.sum()), 0, f"interior voxels inside the {o['kind']} box")
        # margin: no partition voxel within 1 cell of a window box either (walls only: plaster colour)
        pl = interior.C_PLASTER
        pc = ((pl[0] << 16 | pl[1] << 8 | pl[2]) << 3) | interior.MW
        for o in op:
            if o["kind"] != "window":
                continue
            m = ((xyz[:, 0] >= o["x0"] - 1) & (xyz[:, 0] < o["x1"] + 1) & (xyz[:, 2] >= o["z0"] - 3) & (xyz[:, 2] < o["z1"] + 1) &
                 (xyz[:, 1] >= o["y0"]) & (xyz[:, 1] < o["y1"]) & (codes == pc))
            self.assertEqual(int(m.sum()), 0)
        # the entrance hall sits at the facade door: the room next to the door is circulation / hall
        plan = b.detail.interior_plan
        self.assertEqual(plan.parts[0]["ent"]["kind"], "openings")
        self.assertEqual(b.detail.doors_added, 0)

    def test_entrance_created_without_door(self):
        b, g = self.house()
        xyz, codes, _ = run(b, g)
        self.assertEqual(b.detail.doors_added, 1)
        dc = (interior.C_DOOR[0] << 16 | interior.C_DOOR[1] << 8 | interior.C_DOOR[2]) << 3 | interior.MW
        door = xyz[codes == dc]
        self.assertGreater(len(door), 20)
        self.assertLessEqual(door[:, 1].max() - b.base_y, int(round(2.0 / g.vs)) + 1)

    def _diag_openings(self, b, g, vs):
        """axis aligned boxes around a door and two windows on edge 0 of a rotated (33 degree) building"""
        from shapely.geometry.polygon import orient
        co = np.asarray(orient(b.poly, 1.0).exterior.coords)
        a, c = co[0], co[1]
        t = (c - a) / np.hypot(*(c - a))
        M = (a + c) / 2.0
        ops = []
        for kind, s_, hw, y0, y1 in (("window", -3.0, 0.6, 7, 17), ("window", 3.0, 0.6, 7, 17),
                                     ("door", 0.0, 0.5, 1, int(round(2.0 / vs)))):
            P = M + t * s_
            x0 = int(math.floor((P[0] - hw - g.e0) / vs)); x1 = int(math.ceil((P[0] + hw - g.e0) / vs))
            zc0 = int(math.floor((g.n0 - (P[1] + hw)) / vs)); zc1 = int(math.ceil((g.n0 - (P[1] - hw)) / vs))
            ops.append(dict(edge=0, kind=kind, x0=x0, x1=x1, z0=zc0, z1=zc1, y0=b.base_y + y0, y1=b.base_y + y1))
        return ops

    def test_diagonal_facade_openings(self):
        vs = 0.15
        a = math.radians(33)
        c, s_ = math.cos(a), math.sin(a)
        pts = [(x * c - y * s_, x * s_ + y * c) for x, y in rect(14, 9)]
        b, g = make_building(pts, vs=vs, levels=2, height=7.0, wall_t=2)
        op = self._diag_openings(b, g, vs)
        b.detail.openings = op
        b.detail.wall_t = 2
        xyz, codes, _ = run(b, g)
        plan = b.detail.interior_plan
        self.assertEqual(plan.parts[0]["ent"]["kind"], "openings")
        self.assertEqual(b.detail.doors_added, 0)
        for o in op:
            m = ((xyz[:, 0] >= o["x0"]) & (xyz[:, 0] < o["x1"]) & (xyz[:, 2] >= o["z0"]) & (xyz[:, 2] < o["z1"]) &
                 (xyz[:, 1] >= o["y0"]) & (xyz[:, 1] < o["y1"]))
            self.assertEqual(int(m.sum()), 0, f"interior voxels inside the diagonal {o['kind']} box")
        self.assert_walkable(b, g, xyz, "diagonal facade")

    def test_painted_entrance_avoids_windows_and_openings_on_other_parts_are_ignored(self):
        vs = 0.15
        # windows all along the south wall and no door: the painted door must go elsewhere, glass is never overwritten
        b, g = make_building(rect(12, 8), vs=vs, levels=2, height=7.0, wall_t=2)
        zmax = int(b.wz.max())
        xs = sorted(set(b.wx[b.wz == zmax].tolist()))
        op = [dict(edge=0, kind="window", x0=x, x1=min(x + 12, xs[-1] + 1), z0=zmax - 1, z1=zmax + 1,
                   y0=b.base_y + 4, y1=b.base_y + 15) for x in range(xs[0] + 2, xs[-1] - 12, 16)]
        b.detail.openings = op
        b.detail.wall_t = 2
        xyz, codes, _ = run(b, g)
        dc = (interior.C_DOOR[0] << 16 | interior.C_DOOR[1] << 8 | interior.C_DOOR[2]) << 3 | interior.MW
        door = xyz[codes == dc]
        self.assertGreater(len(door), 10)
        for o in op:
            m = ((door[:, 0] >= o["x0"] - 1) & (door[:, 0] < o["x1"] + 1) & (door[:, 2] >= o["z0"] - 3) &
                 (door[:, 2] < o["z1"] + 1))
            self.assertEqual(int(m.sum()), 0, "painted door overlaps a window zone")
        # an opening far from this member's outline (it belongs to another part of the record ring) is ignored
        b2, g2 = make_building(rect(12, 8), vs=vs, levels=2, height=7.0, wall_t=2)
        far = dict(edge=5, kind="door", x0=3, x1=9, z0=3, z1=6, y0=b2.base_y + 1, y1=b2.base_y + 14)
        b2.detail.openings = [far]
        run(b2, g2)
        self.assertNotEqual(b2.detail.interior_plan.parts[0]["ent"]["kind"], "openings")
        self.assertEqual(b2.detail.doors_added, 1)

    def test_door_width_and_no_nibbling(self):
        vs = 0.1
        b, g = make_building(rect(10, 8), vs=vs, levels=1, height=3.5)
        xyz, codes, _ = run(b, g)
        plan = b.detail.interior_plan
        w = walkcheck.Walk(b, g, xyz)
        y = plan.floor_ys[0] + 1
        lv = plan.parts[0]["levels"][0]
        checked = 0
        for (i, j, c) in lv["doors"]:
            # find the wall direction: the door cell is a gap in a wall of plaster; probe both axes
            E, N = walkcheck.plan_world(plan, c)
            x, z = w.cell(E, N)
            for axis in ((1, 0), (0, 1)):
                # width of the opening in the wall = contiguous standable cells along `axis` through the door centre
                left = right = 0
                while w.standable(x + axis[0] * (right + 1), y, z + axis[1] * (right + 1)) and right < 30:
                    right += 1
                while w.standable(x - axis[0] * (left + 1), y, z - axis[1] * (left + 1)) and left < 30:
                    left += 1
                width = (left + right + 1) * vs
                # the axis along the wall is the one where the door is a bounded gap (not the open room axis)
                if width <= DOOR_MAX:
                    self.assertGreaterEqual(width, 0.9 - 2 * vs)
                    self.assertLessEqual(width, 0.9 + 2 * vs + 1e-9, f"door {width:.2f} m wide")
                    checked += 1
        self.assertGreaterEqual(checked, 3)

    # -- shapes
    def test_concave_L_footprint(self):
        L = [(0, 0), (16, 0), (16, 6), (7, 6), (7, 14), (0, 14)]
        b, g = make_building(L, levels=2, height=7.0)
        xyz, codes, dt = run(b, g)
        self.assertGreaterEqual(b.detail.rooms, 5)
        # nothing outside the footprint's free interior or its shell
        from voxelworlds.voxel.grid import cells_in_geom
        ix, iz = cells_in_geom(b.poly, g)
        inside = set(zip(ix.tolist(), iz.tolist()))
        outside = [(x, z) for x, z in zip(xyz[:, 0].tolist(), xyz[:, 2].tolist()) if (x, z) not in inside]
        self.assertEqual(len(outside), 0)

    def test_courtyard_footprint(self):
        outer = rect(30, 24)
        hole = rect(10, 8, 10, 8)
        b, g = make_building(outer, holes=[hole], levels=3, height=10.5, vs=0.25)
        xyz, codes, dt = run(b, g)
        self.assertGreater(b.detail.rooms, 6)
        # courtyard cells (air): no interior voxel strictly inside the hole
        hx0 = int((E0 + 10.5 - g.e0) / g.vs); hx1 = int((E0 + 19.5 - g.e0) / g.vs)
        hz0 = int((g.n0 - (N0 + 15.5)) / g.vs); hz1 = int((g.n0 - (N0 + 8.5)) / g.vs)
        m = (xyz[:, 0] > hx0) & (xyz[:, 0] < hx1) & (xyz[:, 2] > hz0) & (xyz[:, 2] < hz1)
        self.assertEqual(int(m.sum()), 0)

    def test_kiosk_tiny(self):
        b, g = make_building(rect(2.4, 2.4), levels=1, height=3.0, kind="commercial", btype="kiosk")
        xyz, codes, dt = run(b, g)
        self.assertGreater(len(xyz), 100)
        self.assertEqual(b.detail.rooms, 1)

    def test_tiny_multilevel_no_stairs_warns_not_crashes(self):
        b, g = make_building(rect(2.5, 2.5), levels=3, height=9.0)
        xyz, codes, dt = run(b, g)
        self.assertTrue(any(w[0].startswith("INTERIOR") for w in b.detail.warnings))

    def test_other_kinds(self):
        slab = (interior.C_SLAB[0] << 16 | interior.C_SLAB[1] << 8 | interior.C_SLAB[2]) << 3 | interior.MO
        cases = {   # kind, btype -> (expected room type on the ground floor, expected storeys built)
            ("industrial", "warehouse"): ("industrial", 1), ("religious", "church"): ("nave", 1),
            ("civic", "school"): ("office", 2), ("generic", "yes"): ("shop", 2), ("commercial", "retail"): ("shop", 2)}
        for (kind, bt), (rtype, built) in cases.items():
            b, g = make_building(rect(24, 14), levels=2, height=8.0, kind=kind, btype=bt, vs=0.2)
            xyz, codes, dt = run(b, g)
            self.assertGreater(len(xyz), 1000, kind)
            self.assertEqual(b.detail.levels_built, built, kind)
            self.assertEqual(len(b.detail.floor_ys_built), built, kind)
            plan = b.detail.interior_plan
            types = [r["type"] for r in plan.parts[0]["levels"][0]["rooms"]]
            self.assertIn(rtype, types, f"{kind}: {types}")
            if kind in ("industrial", "religious"):
                self.assertEqual(len(plan.parts[0]["levels"]), 1)
                self.assertGreater(int((codes == slab).sum()), 20, f"{kind}: no columns / pillars")
            else:
                self.assertEqual(len(plan.parts[0]["levels"]), 2)
                self.assertIsNotNone(plan.parts[0]["spec"], kind)
            if kind == "civic":
                self.assertGreaterEqual(b.detail.rooms, 6)
            self.assert_walkable(b, g, xyz, kind)
        # a tall single-level kind: the slab count reported is what was built
        b, g = make_building(rect(24, 14), levels=4, height=14.0, kind="industrial", btype="warehouse", vs=0.2)
        run(b, g)
        self.assertEqual(b.detail.levels_built, 1)
        self.assertEqual(b.detail.floor_ys_built, [b.base_y])

    def test_rotated_footprint(self):
        a = math.radians(33)
        c, s = math.cos(a), math.sin(a)
        pts = [(x * c - y * s, x * s + y * c) for x, y in rect(14, 9)]
        b, g = make_building(pts, levels=2, height=7.0)
        xyz, codes, dt = run(b, g)
        self.assertGreaterEqual(b.detail.rooms, 3)
        plan = b.detail.interior_plan
        self.assertAlmostEqual(abs(plan.parts[0]["frame"][2]) % 180, 33.0, delta=1.0)

    # -- budget / cancel
    def test_budget_simplifies_then_limit(self):
        b, g = make_building(rect(40, 30), levels=4, height=14.0, vs=0.2)
        full, _, _ = run(b, g)
        b2, g2 = make_building(rect(40, 30), levels=4, height=14.0, vs=0.2, max_voxels=int(len(full) * 0.7))
        small, _, _ = run(b2, g2)
        self.assertLessEqual(len(small), int(len(full) * 0.7))
        self.assertIn("INTERIOR_SIMPLIFIED", [w[0] for w in b2.detail.warnings])
        b3, g3 = make_building(rect(40, 30), levels=4, height=14.0, vs=0.2, max_voxels=1000)
        with self.assertRaises(PipelineError) as c:
            run(b3, g3)
        self.assertEqual(c.exception.code, "VOXEL_LIMIT")

    def test_cancel_latency(self):
        """longest gap between two check() calls (not wall clock) on a 200 x 150 m footprint"""
        for kind, bt, lv, vs in (("commercial", "retail", 2, 0.5), ("industrial", "warehouse", 1, 0.5),
                                 ("religious", "church", 1, 0.5)):
            stamps = []
            b, g = make_building(rect(200, 150), levels=lv, height=lv * 4.0, vs=vs, kind=kind, btype=bt,
                                 check=lambda: stamps.append(time.perf_counter()))
            stamps.append(time.perf_counter())
            run(b, g)
            gaps = np.diff(stamps)
            self.assertGreater(len(stamps), 50, kind)
            self.assertLess(float(gaps.max()), 0.1, f"{kind}: longest gap between cancel checks {gaps.max() * 1000:.0f} ms")
        # and a raising check aborts promptly
        n = {"i": 0}

        def boom():
            n["i"] += 1
            if n["i"] == 25:
                raise Cancelled()
        outer, hole = rect(70, 50), rect(30, 20, 20, 15)
        b2, g2 = make_building(outer, holes=[hole], levels=5, height=17.5, vs=0.2, kind="commercial", btype="office",
                               check=boom)
        with self.assertRaises(Cancelled):
            run(b2, g2)
        self.assertEqual(n["i"], 25)

    def test_large_floor_corridor_network(self):
        b, g = make_building(rect(70, 40), holes=[rect(24, 14, 23, 13)], levels=3, height=10.5, vs=0.25,
                             kind="commercial", btype="office")
        run(b, g)
        part = b.detail.interior_plan.parts[0]
        self.assertTrue(part["large"])
        area = part["levels"][0]["rooms"][0]["poly_uv"].area            # any room: just to have shapes
        self.assertGreaterEqual(len(part["specs"]), 4)                  # one core per ~600 m2 of floor
        for lv in part["levels"]:
            rooms, doors = lv["rooms"], lv["doors"]
            plain = [i for i, r in enumerate(rooms) if not r["circ"] and r["type"] not in ("stairs", "lift")]
            self.assertTrue(all(rooms[i]["poly_uv"].area <= 95.0 for i in plain), "room larger than ~8 x 8 m")
            parent = {bb: a for (a, bb, c) in doors}
            on_corridor = [i for i in plain if i in parent and rooms[parent[i]]["circ"]]
            self.assertGreaterEqual(len(on_corridor) / len(plain), 0.9, "rooms must open onto corridors")
            self.assertEqual(lv["unreachable"], [])
            # egress: every room within 45 m (straight line) of a stair core
            aprons = [((sp["aprons"][0][0] + sp["aprons"][0][2]) / 2, (sp["aprons"][0][1] + sp["aprons"][0][3]) / 2)
                      for sp in part["specs"]]
            for i in plain:
                c = rooms[i]["poly_uv"].centroid
                self.assertLess(min(math.hypot(c.x - a[0], c.y - a[1]) for a in aprons), 45.0)
        self.assertGreaterEqual(b.detail.doors_added, 2)                # several exits

    def test_large_block(self):
        outer = rect(60, 40)
        hole = rect(26, 16, 17, 12)
        b, g = make_building(outer, holes=[hole], levels=6, height=21.0, vs=0.25, kind="commercial", btype="office")
        xyz, codes, dt = run(b, g)
        self.assertGreater(b.detail.rooms, 30)
        self.assertLess(dt, 15.0)


def b_world(b, plan, uv):
    return walkcheck.plan_world(plan, uv)


if __name__ == "__main__":
    unittest.main()
