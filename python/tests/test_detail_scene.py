"""Building index + 'detail' scene on a synthetic OSM extract (no network)."""
import json, os, sys, tempfile, unittest
from unittest import mock
import numpy as np
import geopandas as gpd
import pandas as pd
from shapely.geometry import Polygon
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from voxelworlds.config import DEFAULT_CONFIG as cfg
from voxelworlds.protocol import Emitter, Job, PipelineError
from voxelworlds.voxel import bindex
from voxelworlds.voxel.buildings import extract_buildings
from voxelworlds.voxel.grid import make_grid
from voxelworlds.voxel.vwg import read_vwg

LAT, LON = 47.3700, 8.5400
BBOX = dict(latMin=LAT - 0.0006, latMax=LAT + 0.0006, lonMin=LON - 0.0009, lonMax=LON + 0.0009)
M_LAT, M_LON = 111_320.0, 111_320.0 * np.cos(np.radians(LAT))


def box_ll(dx, dy, w, h):
    """Rectangle (metres east/north of the bbox centre) as a lon/lat polygon."""
    pts = [(dx, dy), (dx + w, dy), (dx + w, dy + h), (dx, dy + h)]
    return Polygon([(LON + x / M_LON, LAT + y / M_LAT) for x, y in pts])


def synthetic_gdf():
    rows = [
        (("way", 101), box_ll(-30, -10, 14, 9), dict(building="apartments", **{"building:levels": "4"})),
        (("way", 102), box_ll(-10, -10, 10, 8), dict(building="house", height="7")),
        (("way", 103), box_ll(6, -10, 8, 8), dict(building="yes")),
        (("way", 104), box_ll(6, -9, 4, 6), {"building:part": "yes", "building:levels": "5"}),  # part of 103
        (("relation", 7), box_ll(18, -10, 12, 9), dict(building="commercial")),
    ]
    idx = pd.MultiIndex.from_tuples([r[0] for r in rows], names=["element_type", "osmid"])
    data = pd.DataFrame([r[2] for r in rows], index=idx)
    return gpd.GeoDataFrame(data, geometry=[r[1] for r in rows], crs=4326)


def utm_records(mpf=3.5):
    grid, to_utm = make_grid(BBOX, 1.0)
    g = synthetic_gdf().to_crs(grid.epsg)
    recs = []
    bs = extract_buildings(g, cfg, mpf, 10.5, None, recs)
    return grid, bs, recs


class Sink:
    def __init__(self): self.ev = []
    def write(self, l): self.ev.append(json.loads(l))
    def flush(self): pass


class IndexTests(unittest.TestCase):
    def test_entries_sorted_ccw_parts_folded(self):
        grid, bs, recs = utm_records()
        idx = bindex.build_index(recs, bs, grid, None, 3.5)
        ids = [b["id"] for b in idx["buildings"]]
        self.assertEqual(ids, sorted(ids))
        self.assertEqual(ids, ["relation/7", "way/101", "way/102", "way/103"])  # way/104 is a part of 103
        b103 = [b for b in idx["buildings"] if b["id"] == "way/103"][0]
        self.assertGreaterEqual(b103["levels"], 1)
        self.assertGreater(b103["heightM"], 10.0)  # part levels=5 counted in the parent's height
        for b in idx["buildings"]:
            f = np.array(b["footprint"])
            self.assertNotEqual(tuple(f[0]), tuple(f[-1]))
            area = 0.5 * np.sum(f[:, 0] * np.roll(f[:, 1], -1) - np.roll(f[:, 0], -1) * f[:, 1])
            self.assertLess(area, 0)  # CCW on the map (x east, z south) shows as negative shoelace area
            self.assertGreater(b["topY"], b["baseY"])

    def test_independent_of_input_order(self):
        grid, bs, recs = utm_records()
        a = bindex.build_index(recs, bs, grid, None, 3.5)
        b = bindex.build_index(list(reversed(recs)), list(reversed(bs)), grid, None, 3.5)
        self.assertEqual(json.dumps(a), json.dumps(b))
        # a coarser/finer grid shifts nothing but the grid units: same element ids
        g2, bs2, recs2 = utm_records()
        self.assertEqual([x["id"] for x in a["buildings"]],
                         [x["id"] for x in bindex.build_index(recs2, bs2, g2, None, 3.5)["buildings"]])


class PaintTests(unittest.TestCase):
    def setup(self, vs=0.2):
        from voxelworlds.voxel.grid import Grid
        grid = Grid(32633, 33, "N", 0.0, 100.0, vs, int(30 / vs), int(30 / vs))
        poly = Polygon([(5, 80), (19, 80), (19, 89), (5, 89)])  # CCW in (E, N); edge 0 runs east on the south side
        return grid, poly

    def test_strips_equal_single_shot(self):
        from voxelworlds.voxel import facade_paint
        grid, poly = self.setup()
        spec = DetailTests.SPEC
        a = facade_paint.paint_edge(poly, 0, spec, grid, 0, 60, "way/1", chunk_elems=10 ** 9)
        calls = []
        b = facade_paint.paint_edge(poly, 0, spec, grid, 0, 60, "way/1", check=lambda: calls.append(1),
                                    chunk_elems=300)
        self.assertGreater(len(calls), 5)
        self.assertGreater(len(a.x), 1000)
        for k in ("x", "y", "z", "rgb"):
            np.testing.assert_array_equal(getattr(a, k), getattr(b, k))
        self.assertEqual((a.windows, a.doors), (b.windows, b.doors))

    def test_painted_boxes_match_the_spec_rects_within_one_voxel(self):
        """facade2-like layout (3 windows top, 2 + door below, bays on one floor only): u grows left -> right,
        v up, nothing dropped or merged, door and windows are distinct, no stray glass"""
        from voxelworlds.voxel import facade_paint
        for vs in (0.1, 0.2):
            grid, poly = self.setup(vs)
            p0x, p0y = 5.0, 80.0                       # edge 0 runs east from here (south wall of the footprint)
            Hw = (60 - 0 - 1) * vs
            wins = [dict(u=4.0, v=3.2, w=2.0, h=1.8), dict(u=7.5, v=3.2, w=2.0, h=1.8), dict(u=11.0, v=3.2, w=2.0, h=1.8),
                    dict(u=7.5, v=0.8, w=2.0, h=1.8), dict(u=11.0, v=0.8, w=2.0, h=1.8)]
            door = dict(u=0.8, v=0, w=1.6, h=2.4)
            glass = (11, 22, 33)
            spec = {"version": 1, "wallWidthM": 14, "wallHeightM": Hw, "floors": 2, "floorLinesV": [],
                    "wallColour": [200, 120, 92], "trimColour": [235, 230, 220], "glassColour": list(glass),
                    "material": "plaster", "windows": wins, "doors": [door]}
            r = facade_paint.paint_edge(poly, 0, spec, grid, 0, 60, "way/1")
            self.assertEqual((r.windows, r.doors), (5, 1))
            wb = [o for o in r.openings if o["kind"] == "window"]
            db = [o for o in r.openings if o["kind"] == "door"]
            self.assertEqual((len(wb), len(db)), (5, 1))

            def box_of(rect):      # expected voxel box of a spec rect (x: east index, y: row above base 0)
                u0, v0, w, h = rect["u"], rect["v"], rect["w"], rect["h"]
                return (int(round((p0x + u0 - grid.e0) / vs)), int(round((p0x + u0 + w - grid.e0) / vs)),
                        1 + int(round(v0 / vs)), 1 + int(round((v0 + h) / vs)))
            for spec_r, o in list(zip(sorted(wins, key=lambda r: (r["u"], r["v"])),
                                      sorted(wb, key=lambda o: (o["x0"], o["y0"])))) + [(door, db[0])]:
                ex = box_of(spec_r)
                self.assertLessEqual(abs(o["x0"] - ex[0]), 1, (vs, spec_r, o))
                self.assertLessEqual(abs(o["x1"] - ex[1]), 1, (vs, spec_r, o))
                self.assertLessEqual(abs(o["y0"] - ex[2]), 1, (vs, spec_r, o))
                self.assertLessEqual(abs(o["y1"] - ex[3]), 1, (vs, spec_r, o))
            # glass voxels: every one lies in a window rect, every window has glass over (almost) its full inner area
            g = np.all(r.rgb == np.array(glass, np.uint8), axis=1)
            gx, gy = r.x[g], r.y[g]
            inside = np.zeros(len(gx), bool)
            for spec_r in wins:
                ex = box_of(spec_r)
                m = (gx >= ex[0] - 1) & (gx <= ex[1]) & (gy >= ex[2] - 1) & (gy <= ex[3])
                inside |= m
                self.assertGreater(int(m.sum()), 0.5 * (ex[1] - ex[0] - 2) * (ex[3] - ex[2] - 2), f"window {spec_r} lost")
                self.assertLessEqual(int(gx[m].min()) - ex[0], 2)       # frame is at most ~2 voxels
                self.assertLessEqual(ex[1] - 1 - int(gx[m].max()), 2)
            self.assertTrue(inside.all(), "glass outside every window rect")
            # the door: leaf voxels (a door colour) sit inside the door rect only, left of all windows
            dc = {tuple(c) for c in facade_paint.DOOR_COLOURS}
            leaf = np.array([tuple(c) in dc for c in r.rgb.tolist()])
            ex = box_of(door)
            self.assertGreater(int(leaf.sum()), 0)
            self.assertTrue(((r.x[leaf] >= ex[0] - 1) & (r.x[leaf] <= ex[1])).all())
            self.assertLess(int(r.x[leaf].max()), min(box_of(w_)[0] for w_ in wins))

    def test_budget_and_bad_specs(self):
        from voxelworlds.voxel import facade_paint
        grid, poly = self.setup()
        with self.assertRaises(PipelineError) as c:
            facade_paint.paint_edge(poly, 0, DetailTests.SPEC, grid, 0, 60, "way/1", max_elems=100)
        self.assertEqual(c.exception.code, "VOXEL_LIMIT")
        good = DetailTests.SPEC
        for bad in ({**good, "floorLinesV": "3,6"}, {**good, "floorLinesV": [1, "x"]},
                    {**good, "wallColour": [1, 2]}, {**good, "glassColour": "red"},
                    {**good, "windows": [{"u": 1}]}, {**good, "windows": 5}, {**good, "doors": [1]},
                    {**good, "wallWidthM": float("nan")}, "spec", None):
            with self.assertRaises(PipelineError) as c:
                facade_paint.paint_edge(poly, 0, bad, grid, 0, 60, "way/1")
            self.assertEqual(c.exception.code, "BAD_REQUEST", bad)


class DetailTests(unittest.TestCase):
    SPEC = {"version": 1, "wallWidthM": 14, "wallHeightM": 12, "floors": 4, "floorLinesV": [3.0, 6.0, 9.0],
            "wallColour": [200, 120, 92], "trimColour": [235, 230, 220], "glassColour": [11, 22, 33],
            "material": "brick",
            "windows": [{"u": 1.0 + 3.0 * i, "v": 0.9 + 3.0 * f, "w": 1.2, "h": 1.5} for i in range(4) for f in range(4)
                        if not (i == 1 and f == 0)],
            "doors": [{"u": 4.0, "v": 0, "w": 1.0, "h": 2.1}],
            "confidence": {"floors": 1, "windows": 1, "doors": 1, "colour": 1}}

    def run_detail(self, bid="way/101", vs=0.2, facade=True, **kw):
        from voxelworlds.voxel import detail_scene
        d = tempfile.mkdtemp()
        os.environ["VOXEL_TMP_DIR"] = d
        os.environ["VOXEL_CACHE_DIR"] = d
        sink = Sink()
        mv = kw.pop("maxVoxels", 20_000_000)
        gdf_fn = kw.pop("gdf_fn", synthetic_gdf)
        p = dict(ref=dict(bbox=BBOX, buildingId=bid), voxelSize=vs, maxVoxels=mv, **kw)
        if facade:
            p["facade"] = dict(edge=0, spec=self.SPEC)
        with mock.patch("voxelworlds.osm.fetch.fetch_features", lambda *a, **k: gdf_fn()), \
                mock.patch("voxelworlds.osm.fetch.cached_roads_variant", lambda *a, **k: False), \
                mock.patch("voxelworlds.osm.fetch.cached_any", lambda *a, **k: True):
            detail_scene.run_detail(Job("d", Emitter(sink)), p)
        return [e for e in sink.ev if e["type"] == "result"][0], sink

    def test_deterministic_and_painted(self):
        r1, _ = self.run_detail()
        r2, _ = self.run_detail()
        h1, X1, Y1, Z1, C1 = read_vwg(r1["vwgPath"])
        h2, X2, Y2, Z2, C2 = read_vwg(r2["vwgPath"])
        for a, b in zip((X1, Y1, Z1, C1), (X2, Y2, Z2, C2)):
            np.testing.assert_array_equal(a, b)
        self.assertEqual(h1["palette"], h2["palette"])
        self.assertTrue(os.path.basename(r1["vwgPath"]).startswith("vw-"))
        st = r1["stats"]
        self.assertEqual(st["levels"], 4)
        self.assertEqual(len(st["floorYs"]), 4)
        self.assertEqual(st["floorYs"], sorted(st["floorYs"]))
        self.assertEqual(st["doors"], 1)
        self.assertEqual(st["windows"], 15)
        pal = [tuple(c) for c in h1["palette"]]
        self.assertIn((11, 22, 33), pal)  # spec glass colour reached the voxels
        self.assertEqual(st["voxelCount"], len(X1))
        # sorted by (x, z, y), unique
        key = (X1.astype(np.int64) * 10_000_000 + Z1) * 100_000 + Y1
        self.assertTrue(np.all(np.diff(key) > 0))

    def test_without_facade_has_no_glass_colour(self):
        r, _ = self.run_detail(facade=False)
        h = read_vwg(r["vwgPath"])[0]
        self.assertNotIn((11, 22, 33), [tuple(c) for c in h["palette"]])
        self.assertEqual(r["stats"]["windows"], 0)

    def test_neighbours_and_relation(self):
        r0, _ = self.run_detail("way/102", facade=False)
        r1, _ = self.run_detail("way/102", facade=False, includeNeighbours=True)
        self.assertGreater(r1["stats"]["voxelCount"], r0["stats"]["voxelCount"])
        self.run_detail("relation/7", facade=False)

    def test_errors(self):
        with self.assertRaises(PipelineError) as c:
            self.run_detail("way/999")
        self.assertEqual(c.exception.code, "BUILDING_NOT_FOUND")
        with self.assertRaises(PipelineError) as c:
            self.run_detail(vs=0.01)
        self.assertEqual(c.exception.code, "BAD_REQUEST")
        with self.assertRaises(PipelineError) as c:
            self.run_detail(maxVoxels=1000)
        self.assertEqual(c.exception.code, "VOXEL_LIMIT")

    def test_subset_path_identical_to_whole_bbox_path(self):
        from voxelworlds.voxel import detail_scene, buildings as bmod

        def big_gdf():
            g = synthetic_gdf()
            rows = [(("way", 201), box_ll(40, -10, 12, 9), dict(building="apartments", height="30")),    # 40 m away
                    (("way", 202), box_ll(200, -10, 12, 9), dict(building="apartments", height="50")),   # 200 m away
                    (("way", 203), box_ll(-300, 40, 20, 20), dict(building="yes")),
                    (("way", 204), box_ll(-33, -10, 3, 9), dict(building="house", **{"building:levels": "9"})),  # touches way/101
                    (("way", 205), box_ll(20, 200, 20, 20), dict(building="yes"))]
            idx = pd.MultiIndex.from_tuples([r[0] for r in rows], names=["element_type", "osmid"])
            extra = gpd.GeoDataFrame(pd.DataFrame([r[2] for r in rows], index=idx),
                                     geometry=[r[1] for r in rows], crs=4326)
            return pd.concat([g, extra])
        sizes = []
        real = bmod.extract_buildings

        def spy(gdf, *a, **k):
            sizes.append(len(gdf))
            return real(gdf, *a, **k)

        for bid, nb in (("way/103", False), ("way/101", False), ("way/102", True), ("relation/7", True)):
            res = {}
            for use in (True, False):
                with mock.patch.object(detail_scene, "USE_SUBSET", use), \
                        mock.patch.object(detail_scene, "extract_buildings", spy):
                    r, _ = self.run_detail(bid, facade=False, gdf_fn=big_gdf, includeNeighbours=nb,
                                           interior=dict(enabled=True, seed=2))
                h, X, Y, Z, C = read_vwg(r["vwgPath"])
                res[use] = (X, Y, Z, C, h["palette"], r["stats"]["rooms"], r["stats"]["floorYs"])
            for a, b in zip(res[True][:4], res[False][:4]):
                np.testing.assert_array_equal(a, b)
            self.assertEqual(res[True][4:], res[False][4:])
        self.assertLess(sizes[0], sizes[1])        # the subset really is smaller than the whole table
        self.assertEqual(sizes[1], 10)

    def test_bad_interior_options_are_bad_request(self):
        for bad in (dict(enabled=True, levelsOverride="abc"), dict(enabled=True, roomMinM=float("nan")),
                    dict(enabled=True, seed="x"), dict(enabled=True, wallThicknessM=[1])):
            with self.assertRaises(PipelineError) as c:
                self.run_detail(facade=False, interior=bad)
            self.assertEqual(c.exception.code, "BAD_REQUEST")
        # absurd level counts are capped; floor_ys stay sane
        r, _ = self.run_detail(facade=False, interior=dict(enabled=True, levelsOverride=10 ** 9))
        self.assertLessEqual(r["stats"]["levels"], 250)
        self.assertEqual(len(r["stats"]["floorYs"]), r["stats"]["levels"])
        self.assertEqual(len(set(r["stats"]["floorYs"])), r["stats"]["levels"])

    def test_ref_overrides_mpf_and_default_height(self):
        r0, _ = self.run_detail("way/101", facade=False)
        d = tempfile.mkdtemp()
        os.environ["VOXEL_TMP_DIR"] = d
        os.environ["VOXEL_CACHE_DIR"] = d
        from voxelworlds.voxel import detail_scene
        sink = Sink()
        p = dict(ref=dict(bbox=BBOX, buildingId="way/101", metersPerFloor=5.0, defaultBuildingHeight=30.0),
                 voxelSize=0.2, maxVoxels=20_000_000)
        with mock.patch("voxelworlds.osm.fetch.fetch_features", lambda *a, **k: synthetic_gdf()), \
                mock.patch("voxelworlds.osm.fetch.cached_roads_variant", lambda *a, **k: False), \
                mock.patch("voxelworlds.osm.fetch.cached_any", lambda *a, **k: True):
            detail_scene.run_detail(Job("d", Emitter(sink)), p)
        r1 = [e for e in sink.ev if e["type"] == "result"][0]
        g0 = np.diff(r0["stats"]["floorYs"]); g1 = np.diff(r1["stats"]["floorYs"])
        self.assertGreater(g1.min(), g0.max() + 4)        # 5 m storeys (25 rows) vs 3.5 m (17-18 rows) at 0.2 m
        # invalid values are ignored (saved / default values used)
        sink2 = Sink()
        p["ref"].update(metersPerFloor=-1, defaultBuildingHeight="x")
        with mock.patch("voxelworlds.osm.fetch.fetch_features", lambda *a, **k: synthetic_gdf()), \
                mock.patch("voxelworlds.osm.fetch.cached_roads_variant", lambda *a, **k: False), \
                mock.patch("voxelworlds.osm.fetch.cached_any", lambda *a, **k: True):
            detail_scene.run_detail(Job("d", Emitter(sink2)), p)
        r2 = [e for e in sink2.ev if e["type"] == "result"][0]
        self.assertEqual(r2["stats"]["floorYs"], r0["stats"]["floorYs"])

    def test_real_interior_in_detail_scene(self):
        r, sink = self.run_detail("way/101", facade=True, interior=dict(enabled=True, seed=3))
        st = r["stats"]
        self.assertGreaterEqual(st["rooms"], 6)
        self.assertEqual(st["levels"], 4)
        h, X, Y, Z, C = read_vwg(r["vwgPath"])
        r0, _ = self.run_detail("way/101", facade=True)
        self.assertGreater(st["voxelCount"], r0["stats"]["voxelCount"] + 2000)
        self.assertEqual(st["doors"], 1)        # the facade door; the interior did not add another entrance
        # deterministic
        r2, _ = self.run_detail("way/101", facade=True, interior=dict(enabled=True, seed=3))
        h2, X2, Y2, Z2, C2 = read_vwg(r2["vwgPath"])
        np.testing.assert_array_equal(C, C2); np.testing.assert_array_equal(X, X2)
        # tiny voxel budget: interior simplified or VOXEL_LIMIT, never a crash
        try:
            r3, s3 = self.run_detail("way/101", facade=False, interior=dict(enabled=True), maxVoxels=r0["stats"]["voxelCount"] + 9000)
            self.assertIn("INTERIOR_SIMPLIFIED", [e["code"] for e in s3.ev if e["type"] == "warning"])
        except PipelineError as e:
            self.assertEqual(e.code, "VOXEL_LIMIT")

    def _slab_rows(self, r):
        h, X, Y, Z, C = read_vwg(r["vwgPath"])
        ys, cnt = np.unique(Y, return_counts=True)
        return dict(zip(ys.tolist(), cnt.tolist()))

    def test_multi_part_stats_are_consistent_with_what_is_built(self):
        # way/103 is a box with a taller building:part (way/104, 5 levels) on one side; the facade wall may belong to
        # either member, but levels / floorYs always describe the member the interior is built in
        for facade in (False, True):
            for interior in (None, dict(enabled=True, seed=4)):
                kw = dict(interior=interior) if interior else {}
                r, sink = self.run_detail("way/103", facade=facade, **kw)
                st = r["stats"]
                self.assertEqual(len(st["floorYs"]), st["levels"], (facade, interior))
                self.assertEqual(st["floorYs"], sorted(set(st["floorYs"])), (facade, interior))
                if interior:
                    rows = self._slab_rows(r)
                    for fy in st["floorYs"]:
                        self.assertIn(fy, rows, f"no slab voxels at floorY {fy}")
                        self.assertGreater(rows[fy], 50, f"floorY {fy} is not a slab")
                    self.assertGreaterEqual(st["rooms"], 1)
        r_a, _ = self.run_detail("way/103", facade=False, interior=dict(enabled=True, seed=4))
        r_b, _ = self.run_detail("way/103", facade=True, interior=dict(enabled=True, seed=4))
        self.assertEqual(r_a["stats"]["floorYs"], r_b["stats"]["floorYs"])
        self.assertEqual(r_a["stats"]["levels"], r_b["stats"]["levels"])

    def test_single_level_kind_reports_built_slabs(self):
        def gdf_fn():
            rows = [(("way", 301), box_ll(-12, -8, 24, 14), dict(building="industrial", height="12"))]
            idx = pd.MultiIndex.from_tuples([r[0] for r in rows], names=["element_type", "osmid"])
            return gpd.GeoDataFrame(pd.DataFrame([r[2] for r in rows], index=idx), geometry=[r[1] for r in rows], crs=4326)
        r, _ = self.run_detail("way/301", facade=False, gdf_fn=gdf_fn, interior=dict(enabled=True, seed=1))
        st = r["stats"]
        self.assertEqual(st["levels"], 1)
        self.assertEqual(len(st["floorYs"]), 1)
        rows = self._slab_rows(r)
        self.assertGreater(rows[st["floorYs"][0]], 200)
        r0, _ = self.run_detail("way/301", facade=False, gdf_fn=gdf_fn)
        self.assertGreater(r0["stats"]["levels"], 1)           # without an interior the nominal storeys are reported
        self.assertEqual(len(r0["stats"]["floorYs"]), r0["stats"]["levels"])

    def test_every_building_part_gets_its_own_reachable_interior(self):
        """regression (Metropol): only the largest member had rooms, the other wings were bare slabs"""
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import walkcheck
        from voxelworlds.voxel import interior

        def gdf_fn():
            rows = [(("way", 401), box_ll(-25, -9, 44, 18), dict(building="commercial")),
                    (("way", 402), box_ll(-25, -9, 20, 18), {"building:part": "yes", "building:levels": "3"}),
                    (("way", 403), box_ll(-5, -9, 12, 18), {"building:part": "yes", "building:levels": "5"}),
                    (("way", 404), box_ll(7, -9, 12, 18), {"building:part": "yes", "building:levels": "2"})]
            idx = pd.MultiIndex.from_tuples([r[0] for r in rows], names=["element_type", "osmid"])
            return gpd.GeoDataFrame(pd.DataFrame([r[2] for r in rows], index=idx), geometry=[r[1] for r in rows], crs=4326)
        calls = []
        real = interior.build_interior

        def spy(building, opts, grid, rng):
            xyz, codes = real(building, opts, grid, rng)
            calls.append((building, grid, xyz))
            return xyz, codes
        with mock.patch("voxelworlds.voxel.interior.build_interior", spy), \
                mock.patch("voxelworlds.voxel.detail_scene.RELEASE_BUILDING_ARRAYS", False):
            r, sink = self.run_detail("way/401", vs=0.25, facade=False, gdf_fn=gdf_fn, interior=dict(enabled=True, seed=1))
        self.assertGreaterEqual(len(calls), 3, "one interior build per building part")
        self.assertGreaterEqual(r["stats"]["rooms"], 12)
        self.assertNotIn("INTERIOR_FAILED", [e["code"] for e in sink.ev if e["type"] == "warning"])
        areas = []
        for b, grid, xyz in calls:
            if b.poly.area < 30:
                continue
            areas.append(b.poly.area)
            self.assertGreater(b.detail.rooms, 0, f"part {b.key} has no rooms")
            res = walkcheck.analyse(b, grid, xyz)
            self.assertTrue(res["start_ok"], f"part {b.key}: nothing standable behind its entrance")
            self.assertEqual(res["missing_rooms"], [], f"part {b.key}")
        self.assertGreaterEqual(len(areas), 3)

    @unittest.skipUnless(os.path.isdir(os.environ.get("VOXEL_METROPOL_CACHE", "")), "needs the Zuerich OSM cache (VOXEL_METROPOL_CACHE)")
    def test_metropol_all_wings_furnished(self):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import walkcheck
        from voxelworlds.voxel import interior, detail_scene
        os.environ["VOXEL_CACHE_DIR"] = os.environ["VOXEL_METROPOL_CACHE"]
        os.environ["VOXEL_TMP_DIR"] = tempfile.mkdtemp()
        calls = []
        real = interior.build_interior

        def spy(building, opts, grid, rng):
            out = real(building, opts, grid, rng)
            calls.append((building, grid, out[0]))
            return out
        sink = Sink()
        p = dict(ref=dict(bbox=dict(latMin=47.3640, latMax=47.3700, lonMin=8.5380, lonMax=8.5480),
                          buildingId="way/290296830", metersPerFloor=3.0, defaultBuildingHeight=9.0),
                 voxelSize=0.15, maxVoxels=100_000_000, interior=dict(enabled=True))
        with mock.patch("voxelworlds.voxel.interior.build_interior", spy), \
                mock.patch("voxelworlds.voxel.detail_scene.RELEASE_BUILDING_ARRAYS", False):
            detail_scene.run_detail(Job("m", Emitter(sink)), p)
        big = [c for c in calls if c[0].poly.area > 100]
        self.assertGreaterEqual(len(big), 4)
        for b, grid, xyz in big:
            self.assertGreater(b.detail.rooms, 3, b.key)
            res = walkcheck.analyse(b, grid, xyz)
            self.assertTrue(res["start_ok"], b.key)
            self.assertEqual(res["missing_rooms"], [], b.key)

    def test_missing_cache_fails_fast_without_network(self):
        import time
        from voxelworlds.voxel import detail_scene
        d = tempfile.mkdtemp()
        os.environ["VOXEL_TMP_DIR"] = d
        os.environ["VOXEL_CACHE_DIR"] = d             # empty cache: nothing for this bbox

        def never(*a, **k):
            raise AssertionError("Overpass must not be called from a detail request")
        p = dict(ref=dict(bbox=BBOX, buildingId="way/101"), voxelSize=0.2, maxVoxels=20_000_000)
        t0 = time.time()
        with mock.patch("voxelworlds.osm.fetch.fetch_features", never):
            with self.assertRaises(PipelineError) as c:
                detail_scene.run_detail(Job("d", Emitter(Sink())), p)
        self.assertEqual(c.exception.code, "NO_DATA")
        self.assertIn("generate the scene again", c.exception.message)
        self.assertLess(time.time() - t0, 2.0)

    def test_memory_estimate_rejects_huge_scene_with_a_clear_message(self):
        def gdf_fn():
            rows = [(("way", 501), box_ll(-60, -60, 120, 120), dict(building="commercial", height="12"))]
            idx = pd.MultiIndex.from_tuples([r[0] for r in rows], names=["element_type", "osmid"])
            return gpd.GeoDataFrame(pd.DataFrame([r[2] for r in rows], index=idx), geometry=[r[1] for r in rows], crs=4326)
        with self.assertRaises(PipelineError) as c:
            self.run_detail("way/501", vs=0.05, facade=False, gdf_fn=gdf_fn, maxVoxels=200_000_000,
                            interior=dict(enabled=True))
        self.assertEqual(c.exception.code, "VOXEL_LIMIT")
        self.assertRegex(c.exception.message, r"estimated ~[0-9.]+ GB")
        self.assertIn("raise the voxel size", c.exception.message)

    def test_voxel_limit_messages_quote_the_users_numbers(self):
        r0, _ = self.run_detail("way/101", facade=False)
        need = r0["stats"]["voxelCount"]
        for kw in (dict(maxVoxels=need - 5000), dict(maxVoxels=need + 3000, interior=dict(enabled=True))):
            with self.assertRaises(PipelineError) as c:
                self.run_detail("way/101", facade=False, **kw)
            self.assertEqual(c.exception.code, "VOXEL_LIMIT")
            self.assertIn(f"{kw['maxVoxels']:,}", c.exception.message, c.exception.message)
            self.assertNotIn("remaining", c.exception.message)

    def test_levels_clamp_to_what_fits_and_stats_match(self):
        from voxelworlds.voxel import interior
        for lv in (6, 40, 10 ** 9):
            r, sink = self.run_detail("way/102", facade=False, vs=0.2, interior=dict(enabled=True, levelsOverride=lv, seed=1))
            st = r["stats"]
            self.assertGreaterEqual(st["levels"], 1)
            self.assertEqual(len(st["floorYs"]), st["levels"])
            gaps = np.diff(st["floorYs"])
            if len(gaps):
                self.assertGreaterEqual(int(gaps.min()), interior.min_storey_rows(0.2))
            rows = self._slab_rows(r)
            for fy in st["floorYs"]:
                self.assertGreater(rows.get(fy, 0), 50)
            warn = [e["message"] for e in sink.ev if e["type"] == "warning" and e["code"] == "INTERIOR_SIMPLIFIED"]
            self.assertTrue(any("storey" in m for m in warn), (lv, warn))
            self.assertGreaterEqual(st["rooms"], 1)

    def test_cancel_during_voxelisation_is_prompt(self):
        import threading, time
        from voxelworlds.voxel import detail_scene

        def big():
            rows = [(("way", 601), box_ll(-80, -60, 160, 120), dict(building="commercial", height="14"))]
            idx = pd.MultiIndex.from_tuples([r[0] for r in rows], names=["element_type", "osmid"])
            return gpd.GeoDataFrame(pd.DataFrame([r[2] for r in rows], index=idx), geometry=[r[1] for r in rows], crs=4326)
        d = tempfile.mkdtemp()
        os.environ["VOXEL_TMP_DIR"] = d
        os.environ["VOXEL_CACHE_DIR"] = d
        job = Job("d", Emitter(Sink()))
        p = dict(ref=dict(bbox=BBOX, buildingId="way/601"), voxelSize=0.06, maxVoxels=100_000_000)
        t_cancel = []

        def later():
            while True:
                time.sleep(0.01)
                if job._last[0] == "init" and time.time() - t0 > 0.4:
                    t_cancel.append(time.time()); job.cancel_event.set(); return
        t0 = time.time()
        threading.Thread(target=later, daemon=True).start()
        with mock.patch("voxelworlds.osm.fetch.fetch_features", lambda *a, **k: big()), \
                mock.patch("voxelworlds.osm.fetch.cached_roads_variant", lambda *a, **k: False), \
                mock.patch("voxelworlds.osm.fetch.cached_any", lambda *a, **k: True):
            from voxelworlds.protocol import Cancelled
            with self.assertRaises(Cancelled):
                detail_scene.run_detail(job, p)
        if t_cancel:
            self.assertLess(time.time() - t_cancel[0], 0.5)

    def test_interior_stub_hook_called(self):
        called = {}

        def fake(building, opts, grid, rng):
            called["levels"] = building.detail.levels
            called["floor_ys"] = list(building.detail.floor_ys)
            return np.empty((0, 3), np.int32), np.empty(0, np.uint32)
        with mock.patch("voxelworlds.voxel.interior.build_interior", fake):
            self.run_detail(facade=False, interior=dict(enabled=True))
        self.assertEqual(called["levels"], 4)
        self.assertEqual(len(called["floor_ys"]), 4)


if __name__ == "__main__":
    unittest.main()
