"""Local Geofabrik .osm.pbf source (osm/pbf.py) on a tiny synthetic extract written with pyosmium. No network."""
import dataclasses
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402

try:
    import osmium  # noqa: E402
except ImportError:  # pragma: no cover
    raise unittest.SkipTest("pyosmium is not installed")

from pbf_fixture import BBOX, HEADER_BOX, write_pbf  # noqa: E402
from voxelworlds import cache  # noqa: E402
from voxelworlds.config import DEFAULT_CONFIG as CFG  # noqa: E402
from voxelworlds.osm import fetch, pbf  # noqa: E402
from voxelworlds.protocol import Cancelled, Emitter, Job, PipelineError  # noqa: E402

SCAN = dataclasses.replace(CFG, pbf_index_min_bytes=10 ** 12)     # always scan
INDEXED = dataclasses.replace(CFG, pbf_index_min_bytes=0)         # always index


class Sink:
    def __init__(self):
        self.ev = []

    def write(self, line):
        self.ev.append(json.loads(line))

    def flush(self):
        pass


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="vw-pbf-test-")
        cls.path = os.path.join(cls.tmp, "syn.osm.pbf")
        cls.ids = write_pbf(cls.path)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.cache_dir = tempfile.mkdtemp(prefix="vw-pbf-cache-")
        self._env = mock.patch.dict(os.environ, {"VOXEL_CACHE_DIR": self.cache_dir, "VOXEL_TMP_DIR": self.cache_dir})
        self._env.start()
        self.addCleanup(self._env.stop)
        self.addCleanup(shutil.rmtree, self.cache_dir, True)
        self.src = pbf.resolve_source({"kind": "pbf", "regionId": "syn", "pbfPath": self.path})
        self.addCleanup(self._rm_index_files)
        self._rm_index_files()

    def _rm_index_files(self):
        for fn in os.listdir(self.tmp):
            if ".vwidx" in fn:
                os.remove(os.path.join(self.tmp, fn))

    def fetch(self, cfg=SCAN, roads=True, bbox=BBOX, stop=None, src=None, on_progress=None):
        return pbf.fetch_features(bbox, roads, cfg, stop or threading.Event(), src or self.src, on_progress)


class SourceValidation(Base):
    def test_overpass_and_absent(self):
        self.assertIsNone(pbf.resolve_source(None))
        self.assertIsNone(pbf.resolve_source({"kind": "overpass"}))

    def test_bad_requests(self):
        bad = [
            "x", {"kind": "wat"},
            {"kind": "pbf", "regionId": "r"},                                        # no path
            {"kind": "pbf", "pbfPath": self.path},                                    # no region
            {"kind": "pbf", "regionId": " ", "pbfPath": self.path},
            {"kind": "pbf", "regionId": "r", "pbfPath": os.path.join(self.tmp, "nope.osm.pbf")},   # missing
            {"kind": "pbf", "regionId": "r", "pbfPath": self.tmp},                    # directory
            {"kind": "pbf", "regionId": "r", "pbfPath": 5},
        ]
        for ds in bad:
            with self.assertRaises(PipelineError) as c:
                pbf.resolve_source(ds)
            self.assertEqual(c.exception.code, "BAD_REQUEST", ds)

    def test_missing_file_code_is_configurable_for_detail(self):
        with self.assertRaises(PipelineError) as c:
            pbf.resolve_source({"kind": "pbf", "regionId": "r", "pbfPath": os.path.join(self.tmp, "gone.pbf")},
                               missing_code="NO_DATA")
        self.assertEqual(c.exception.code, "NO_DATA")
        with self.assertRaises(PipelineError) as c:      # a directory is never "just missing"
            pbf.resolve_source({"kind": "pbf", "regionId": "r", "pbfPath": self.tmp}, missing_code="NO_DATA")
        self.assertEqual(c.exception.code, "BAD_REQUEST")

    def test_source_signature_tracks_file_identity(self):
        p = os.path.join(self.tmp, "sig.osm.pbf")
        shutil.copy(self.path, p)
        a = pbf.resolve_source({"kind": "pbf", "regionId": "r", "pbfPath": p})
        os.utime(p, (1_700_000_000, 1_700_000_000))
        b = pbf.resolve_source({"kind": "pbf", "regionId": "r", "pbfPath": p})
        self.assertNotEqual(a.sig, b.sig)


class Coverage(Base):
    def test_header_box_and_coverage(self):
        self.assertEqual(pbf.header_box(self.src), HEADER_BOX)
        pbf.check_coverage(self.src, BBOX)
        pbf.check_coverage(self.src, dict(latMin=47.39, lonMin=8.59, latMax=47.45, lonMax=8.7))   # partial overlap ok
        with self.assertRaises(PipelineError) as c:
            pbf.check_coverage(self.src, dict(latMin=48.85, lonMin=2.29, latMax=48.86, lonMax=2.30))   # Paris
        self.assertEqual(c.exception.code, "PBF_NO_COVERAGE")

    def test_file_without_header_bbox_is_not_rejected(self):
        p = os.path.join(self.tmp, "nobox.osm.pbf")
        write_pbf(p, header_box=None)
        src = pbf.resolve_source({"kind": "pbf", "regionId": "nb", "pbfPath": p})
        self.assertIsNone(pbf.header_box(src))
        pbf.check_coverage(src, dict(latMin=48.85, lonMin=2.29, latMax=48.86, lonMax=2.30))

    def test_corrupt_file(self):
        p = os.path.join(self.tmp, "corrupt.osm.pbf")
        with open(p, "wb") as f:
            f.write(os.urandom(4096))
        src = pbf.resolve_source({"kind": "pbf", "regionId": "bad", "pbfPath": p})
        with self.assertRaises(PipelineError) as c:
            pbf.check_coverage(src, BBOX)
        self.assertEqual(c.exception.code, "PBF_UNREADABLE")
        with self.assertRaises(PipelineError) as c:
            self.fetch(src=src)
        self.assertEqual(c.exception.code, "PBF_UNREADABLE")

    def test_empty_and_text_files(self):
        for name, data in (("empty.osm.pbf", b""), ("text.osm.pbf", b"<html>not a pbf</html>")):
            p = os.path.join(self.tmp, name)
            with open(p, "wb") as f:
                f.write(data)
            src = pbf.resolve_source({"kind": "pbf", "regionId": name, "pbfPath": p})
            with self.assertRaises(PipelineError) as c:
                pbf.check_coverage(src, BBOX)
            self.assertEqual(c.exception.code, "PBF_UNREADABLE", name)

    def test_truncated_file(self):
        p = os.path.join(self.tmp, "trunc.osm.pbf")
        with open(self.path, "rb") as fh:
            data = fh.read()
        with open(p, "wb") as f:
            f.write(data[: len(data) * 2 // 3])
        src = pbf.resolve_source({"kind": "pbf", "regionId": "trunc", "pbfPath": p})
        with self.assertRaises(PipelineError) as c:
            self.fetch(src=src)
        self.assertEqual(c.exception.code, "PBF_UNREADABLE")

    def test_file_deleted_after_resolve(self):
        p = os.path.join(self.tmp, "gone.osm.pbf")
        shutil.copy(self.path, p)
        src = pbf.resolve_source({"kind": "pbf", "regionId": "gone", "pbfPath": p})
        os.remove(p)
        self.assertFalse(pbf.cached_any(BBOX, src))
        with self.assertRaises(PipelineError) as c:
            self.fetch(src=src)
        self.assertEqual(c.exception.code, "NO_DATA")


class Schema(Base):
    def check(self, g):
        ids = self.ids
        self.assertEqual(g.crs.to_epsg(), 4326)
        self.assertEqual(list(g.index.names), ["element", "id"])
        self.assertTrue(g.index.is_monotonic_increasing)
        self.assertTrue(all(g[c].dtype == object for c in g.columns if c != "geometry"))
        self.assertNotIn("geometry_tag", g.columns)
        rows = set(g.index)
        # present
        for name, el in (("entrance", "node"), ("lamp", "node"), ("tree", "node"), ("bld_levels", "way"),
                         ("bld_height", "way"), ("mp", "relation"), ("part", "way"), ("road", "way"),
                         ("bridge", "way"), ("river", "way"), ("lake", "way"), ("forest", "way"),
                         ("roundabout", "way"), ("fence", "way"), ("area_no", "way")):
            self.assertIn((el, ids[name]), rows, name)
        # absent: outside the bbox, no matching tag, untagged helper ways of the multipolygon
        self.assertNotIn(("way", ids["far"]), rows)
        self.assertNotIn(("node", 2004), rows)
        self.assertNotIn(("way", 190), rows)
        self.assertNotIn(("way", 110), rows)
        self.assertNotIn(("way", 111), rows)
        self.assertEqual(len(g), 15)
        w = lambda i: g.loc[("way", i)]
        self.assertEqual(w(101)["building"], "yes")
        self.assertEqual(w(101)["building:levels"], "4")
        self.assertEqual(w(102)["height"], "12.5")
        self.assertEqual(w(102)["roof:shape"], "gabled")
        self.assertEqual(w(120)["building:part"], "yes")
        self.assertEqual(w(120)["building:colour"], "red")
        self.assertEqual((w(131)["bridge"], w(131)["layer"], w(131)["highway"]), ("yes", "1", "primary"))
        self.assertEqual(w(130)["name"], "Teststrasse")
        self.assertEqual(w(140)["waterway"], "river")
        self.assertEqual(w(141)["natural"], "water")
        self.assertEqual(w(142)["landuse"], "forest")
        self.assertEqual(g.loc[("node", 2001)]["entrance"], "main")
        self.assertEqual(g.loc[("node", 2002)]["man_made"], "street_lamp")
        self.assertEqual(g.loc[("relation", 900)]["type"], "multipolygon")
        self.assertEqual(g.loc[("relation", 900)]["building:levels"], "6")
        # geometry types follow osmnx's rules (area tags -> Polygon, roundabout / fence / area=no stay lines)
        gt = g.geom_type
        for i in (101, 102, 120, 141, 142):
            self.assertEqual(gt[("way", i)], "Polygon", i)
        for i in (130, 131, 140, 150, 160, 180):
            self.assertEqual(gt[("way", i)], "LineString", i)
        self.assertEqual(gt[("node", 2001)], "Point")
        # multipolygon building with a hole
        mp = g.loc[("relation", 900)].geometry
        self.assertEqual(mp.geom_type, "Polygon")
        self.assertEqual(len(mp.interiors), 1)
        self.assertAlmostEqual(mp.area * (111_320.0 ** 2) * np.cos(np.radians(47.366)), 40 * 40 - 15 * 15, delta=8)
        # coordinates are exactly the OSM 1e-7 degree values
        x, y = g.loc[("node", 2001)].geometry.x, g.loc[("node", 2001)].geometry.y
        self.assertAlmostEqual(x * 1e7, round(x * 1e7), places=3)
        self.assertAlmostEqual(y * 1e7, round(y * 1e7), places=3)
        self.assertTrue(g.geometry.is_valid.all())

    def test_scan_schema(self):
        self.check(self.fetch(SCAN))

    def test_indexed_schema(self):
        g = self.fetch(INDEXED)
        self.assertTrue(pbf.has_index(self.src))
        self.check(g)

    def test_scan_and_index_agree_exactly(self):
        a = self.fetch(SCAN)
        shutil.rmtree(os.path.join(self.cache_dir, "pbf"))
        b = self.fetch(INDEXED)
        self.assertEqual(list(a.columns), list(b.columns))
        self.assertTrue(a.index.equals(b.index))
        self.assertTrue(a.drop(columns="geometry").equals(b.drop(columns="geometry")))
        for ga, gb in zip(a.geometry.values, b.geometry.values):
            self.assertTrue(ga.equals_exact(gb, 0.0), (ga.wkt, gb.wkt))

    def test_roads_variant(self):
        g = self.fetch(SCAN, roads=False)
        self.assertNotIn("highway", g.columns)
        self.assertNotIn(("way", 130), set(g.index))
        self.assertIn(("way", 101), set(g.index))
        self.assertIn("highway", self.fetch(SCAN, roads=True).columns)

    def test_bbox_clipping_and_empty(self):
        small = dict(latMin=47.36645, lonMin=8.53998, latMax=47.36655, lonMax=8.54008)     # inside the hole region
        g = self.fetch(SCAN, bbox=small)
        self.assertLess(len(g), 6)
        nothing = dict(latMin=47.34, lonMin=8.57, latMax=47.341, lonMax=8.571)             # in the file, no data
        e = self.fetch(SCAN, bbox=nothing)
        self.assertEqual(len(e), 0)
        self.assertEqual(e.crs.to_epsg(), 4326)
        e2 = self.fetch(INDEXED, bbox=nothing)
        self.assertEqual(len(e2), 0)

    def test_fallback_tag_reader_matches_direct(self):
        a = self.fetch(SCAN)
        shutil.rmtree(os.path.join(self.cache_dir, "pbf"))
        with mock.patch.object(pbf, "_DIRECT", False):
            b = self.fetch(SCAN)
        self.assertTrue(a.drop(columns="geometry").equals(b.drop(columns="geometry")))

    def test_corrupt_index_is_rebuilt(self):
        self.fetch(INDEXED)
        ip = pbf.index_path(self.src)
        with open(ip, "r+b") as f:
            f.seek(0)
            f.write(b"garbage!")
        shutil.rmtree(os.path.join(self.cache_dir, "pbf"))
        self.check(self.fetch(INDEXED))
        with open(ip, "rb") as fh:
            self.assertEqual(fh.read(8), pbf._MAGIC)

    def test_index_failure_falls_back_to_scan(self):
        with mock.patch.object(pbf, "build_index", side_effect=OSError("disk full")):
            self.check(self.fetch(INDEXED))

    def test_index_is_a_sibling_of_the_pbf(self):
        self.fetch(INDEXED)
        self.assertEqual(pbf.index_path(self.src), self.path + ".vwidx")
        self.assertTrue(os.path.isfile(self.path + ".vwidx"))
        self.assertFalse(os.path.isdir(os.path.join(self.cache_dir, "pbfidx")) and
                         os.listdir(os.path.join(self.cache_dir, "pbfidx")))

    def test_changed_file_rebuilds_in_place_and_keeps_other_regions(self):
        """Colliding region names (us / us-west) never touch each other's index; a changed file replaces its own."""
        pa, pb_ = (os.path.join(self.tmp, n) for n in ("us.osm.pbf", "us-west.osm.pbf"))
        shutil.copy(self.path, pa)
        shutil.copy(self.path, pb_)
        sa = pbf.resolve_source({"kind": "pbf", "regionId": "us", "pbfPath": pa})
        sb = pbf.resolve_source({"kind": "pbf", "regionId": "us-west", "pbfPath": pb_})
        self.fetch(INDEXED, src=sb)
        self.fetch(INDEXED, src=sa)
        self.assertTrue(os.path.exists(pb_ + ".vwidx"))
        self.assertTrue(os.path.exists(pa + ".vwidx"))
        os.utime(pa, (1_600_000_000, 1_600_000_000))               # new identity of 'us'
        sa2 = pbf.resolve_source({"kind": "pbf", "regionId": "us", "pbfPath": pa})
        built = []
        real = pbf.build_index
        with mock.patch.object(pbf, "build_index", side_effect=lambda *a, **k: (built.append(1), real(*a, **k))[1]):
            self.fetch(INDEXED, src=sa2)
        self.assertEqual(built, [1])
        self.assertTrue(os.path.exists(pb_ + ".vwidx"))
        idx = pbf._Index.open(pa + ".vwidx", pbf.file_sig(sa2))
        self.assertIn(str(sa2.mtime_ns), idx.toc["meta"]["sig"])
        with self.assertRaises(ValueError):
            pbf._Index.open(pa + ".vwidx", pbf.file_sig(sa))      # the old identity no longer matches
        for f in (pa, pb_, pa + ".vwidx", pb_ + ".vwidx"):
            os.remove(f)

    def test_same_file_other_region_id_reuses_the_index(self):
        self.fetch(INDEXED)
        s2 = pbf.resolve_source({"kind": "pbf", "regionId": "other-name", "pbfPath": self.path})
        with mock.patch.object(pbf, "build_index", side_effect=AssertionError("must reuse")):
            self.assertEqual(len(self.fetch(INDEXED, src=s2)), 15)

    def test_unwritable_pbf_dir_falls_back_to_cache_dir(self):
        with mock.patch.object(pbf, "_writable_dir", return_value=False):
            self.check(self.fetch(INDEXED))
            ip = pbf.index_path(self.src)
        self.assertFalse(os.path.exists(self.path + ".vwidx"))
        self.assertEqual(os.path.dirname(ip), os.path.join(self.cache_dir, "pbfidx"))
        self.assertTrue(os.path.isfile(ip))
        self.assertTrue(pbf.has_index(self.src))

    def test_sweep_stale_parts(self):
        base = self.path + ".vwidx"
        old = time.time() - 3600
        dead = f"{base}.99999999.1.part"
        alive = f"{base}.{os.getppid()}.1.part"
        fresh = f"{base}.99999998.1.part"
        other = os.path.join(self.tmp, "keep.txt.part")
        for f in (dead, alive, fresh, other):
            open(f, "wb").close()
        for f in (dead, alive, other):
            os.utime(f, (old, old))
        n = pbf.sweep_stale_parts(self.src)
        self.assertFalse(os.path.exists(dead))
        self.assertTrue(os.path.exists(alive) or os.name != "posix")
        self.assertTrue(os.path.exists(fresh))
        self.assertTrue(os.path.exists(other))
        self.assertGreaterEqual(n, 1)
        for f in (alive, fresh, other):
            if os.path.exists(f):
                os.remove(f)

    def test_open_sweeps(self):
        dead = f"{self.path}.vwidx.99999999.1.part"
        open(dead, "wb").close()
        old = time.time() - 3600
        os.utime(dead, (old, old))
        self.fetch(INDEXED)
        self.assertFalse(os.path.exists(dead))

    def test_cancel_during_build_leaves_no_part(self):
        ev = threading.Event()
        calls = []

        def cb(f, m):
            calls.append(m)
            if "scanning" in m:
                ev.set()
        with self.assertRaises(Cancelled):
            self.fetch(INDEXED, stop=ev, on_progress=cb)
        left = [f for f in os.listdir(self.tmp) if ".vwidx" in f]
        self.assertEqual(left, [])


class CacheAndProgress(Base):
    def test_second_call_is_a_cache_hit(self):
        a = self.fetch(SCAN)
        with mock.patch.object(pbf, "_extract", side_effect=AssertionError("must not rescan")):
            b = self.fetch(SCAN)
        self.assertEqual(len(a), len(b))

    def test_cache_key_depends_on_file_identity_and_region(self):
        self.fetch(SCAN)
        p = os.path.join(self.tmp, "other.osm.pbf")
        shutil.copy(self.path, p)
        s2 = pbf.resolve_source({"kind": "pbf", "regionId": "syn2", "pbfPath": p})
        calls = []
        real = pbf._extract
        with mock.patch.object(pbf, "_extract", side_effect=lambda *a, **k: (calls.append(1), real(*a, **k))[1]):
            self.fetch(SCAN, src=s2)
        self.assertEqual(len(calls), 1)

    def test_overpass_cache_keys_untouched(self):
        self.fetch(SCAN)
        key = "osm|v6-manmade|%.6f,%.6f,%.6f,%.6f|roads=%d" % (8.538, 47.364, 8.548, 47.37, 1)
        self.assertFalse(cache.has("osm", key, 1e9))
        self.assertEqual(os.listdir(os.path.join(self.cache_dir, "pbf")).__len__(), 1)

    def test_cached_variants(self):
        self.assertTrue(pbf.cached_any(BBOX, self.src))            # file exists: rebuildable
        self.assertTrue(pbf.cached_roads_variant(BBOX, self.src))  # nothing cached -> default roads
        self.fetch(SCAN, roads=False)
        self.assertFalse(pbf.cached_roads_variant(BBOX, self.src))
        self.fetch(SCAN, roads=True)
        self.assertTrue(pbf.cached_roads_variant(BBOX, self.src))
        # dispatch through the Overpass module
        self.assertTrue(fetch.cached_any(BBOX, CFG, self.src))
        self.assertTrue(fetch.cached_roads_variant(BBOX, CFG, self.src))

    def test_fetch_dispatches_on_source(self):
        g = fetch.fetch_features(BBOX, True, SCAN, threading.Event(), source=self.src)
        self.assertEqual(len(g), 15)

    def test_progress_is_monotone_and_ends_at_one(self):
        seen = []
        self.fetch(INDEXED, on_progress=lambda f, m: seen.append((f, m)))
        fr = [f for f, _ in seen]
        self.assertEqual(fr, sorted(fr))
        self.assertEqual(fr[-1], 1.0)
        self.assertTrue(any("Indexing" in m for _, m in seen))
        seen.clear()
        self.fetch(INDEXED, on_progress=lambda f, m: seen.append((f, m)))      # cache hit
        self.assertEqual(seen[-1][0], 1.0)


class Cancel(Base):
    def test_already_cancelled(self):
        ev = threading.Event()
        ev.set()
        with self.assertRaises(Cancelled):
            self.fetch(SCAN, stop=ev)
        with self.assertRaises(Cancelled):
            self.fetch(INDEXED, stop=ev)
        self.assertFalse(pbf.has_index(self.src))          # no partial index left behind
        self.assertEqual([f for f in os.listdir(self.tmp) if ".vwidx" in f], [])

    def test_cancel_latency_on_a_larger_file(self):
        M = osmium.osm.mutable
        p = os.path.join(self.tmp, "big.osm.pbf")
        n_b = 30_000
        with osmium.SimpleWriter(p, overwrite=True) as w:
            nid = 0
            ways = []
            for i in range(n_b):
                x0, y0 = 8.50 + (i % 200) * 0.0002, 47.30 + (i // 200) * 0.0002
                ids = []
                for dx, dy in ((0, 0), (1, 0), (1, 1), (0, 1)):
                    nid += 1
                    w.add_node(M.Node(id=nid, location=(x0 + dx * 1e-4, y0 + dy * 1e-4)))
                    ids.append(nid)
                ways.append((i + 1, ids + ids[:1]))
            for wid, ids in ways:
                w.add_way(M.Way(id=wid, nodes=ids, tags={"building": "yes"}))
        src = pbf.resolve_source({"kind": "pbf", "regionId": "big", "pbfPath": p})
        ev = threading.Event()
        ticks = []
        done = {}

        def run():
            try:
                pbf.fetch_features(dict(latMin=47.30, lonMin=8.50, latMax=47.40, lonMax=8.60), True, SCAN, ev, src)
                done["r"] = "finished"
            except Cancelled:
                done["r"] = "cancelled"
            done["t"] = time.monotonic()

        th = threading.Thread(target=run)
        th.start()
        time.sleep(0.15)
        t_cancel = time.monotonic()
        ev.set()
        th.join(5)
        if done.get("r") == "cancelled":
            self.assertLess(done["t"] - t_cancel, 0.5)
        else:
            self.skipTest("scan finished before the cancel (machine too fast)")

    def test_progress_callback_may_cancel(self):
        def cb(f, m):
            raise Cancelled()
        with self.assertRaises(Cancelled):
            self.fetch(SCAN, on_progress=cb)


class PipelineIntegration(Base):
    def params(self, **kw):
        p = dict(bbox=BBOX, voxelSize=1.0, metersPerFloor=3.5, defaultBuildingHeight=10.5, maxVoxels=20_000_000,
                 features=dict(roads=True, elevation=False, mapillary=False), tileSize=500,
                 dataSource={"kind": "pbf", "regionId": "syn", "pbfPath": self.path})
        p.update(kw)
        return p

    def run_generate(self, p):
        from voxelworlds import pipeline
        sink = Sink()
        job = Job("g", Emitter(sink))
        pipeline.generate(job, p)
        return sink

    def test_generate_from_pbf(self):
        sink = self.run_generate(self.params())
        res = [e for e in sink.ev if e["type"] == "result"]
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["stats"]["buildingCount"], 3)     # 101, 102 and the multipolygon (part folded)
        self.assertGreater(res[0]["stats"]["voxelCount"], 1000)
        stages = {e["stage"] for e in sink.ev if e["type"] == "progress"}
        self.assertIn("pbf", stages)

    def test_generate_is_deterministic_across_tiling(self):
        from voxelworlds.voxel.vwg import read_vwg
        outs = []
        for tile, workers in ((5000, 1), (50, 2)):
            sink = self.run_generate(self.params(tileSize=tile, workers=workers))
            r = [e for e in sink.ev if e["type"] == "result"][0]
            h, X, Y, Z, C = read_vwg(r["vwgPath"])
            outs.append((X.tobytes(), Y.tobytes(), Z.tobytes(), C.tobytes(), json.dumps(h["palette"])))
        self.assertEqual(outs[0], outs[1])

    def test_generate_rejects_bad_sources(self):
        for ds, code in (({"kind": "pbf", "regionId": "x"}, "BAD_REQUEST"),
                         ({"kind": "pbf", "regionId": "x", "pbfPath": os.path.join(self.tmp, "nope")}, "BAD_REQUEST"),
                         ({"kind": "pbf", "regionId": "x", "pbfPath": self.tmp}, "BAD_REQUEST")):
            with self.assertRaises(PipelineError) as c:
                self.run_generate(self.params(dataSource=ds))
            self.assertEqual(c.exception.code, code)

    def test_generate_no_coverage(self):
        far = dict(latMin=48.857, lonMin=2.293, latMax=48.8585, lonMax=2.2965)
        with self.assertRaises(PipelineError) as c:
            self.run_generate(self.params(bbox=far))
        self.assertEqual(c.exception.code, "PBF_NO_COVERAGE")

    def test_generate_unreadable(self):
        p = os.path.join(self.tmp, "junk.osm.pbf")
        with open(p, "wb") as f:
            f.write(b"\x00" * 1000)
        with self.assertRaises(PipelineError) as c:
            self.run_generate(self.params(dataSource={"kind": "pbf", "regionId": "j", "pbfPath": p}))
        self.assertEqual(c.exception.code, "PBF_UNREADABLE")

    def test_overpass_default_unchanged(self):
        # no dataSource -> the Overpass module is used with source=None
        from voxelworlds import pipeline
        seen = {}

        def fake(bbox, roads, cfg, stop, on_chunk=None, source=None, on_pbf=None):
            seen["source"] = source
            return fetch._empty()
        p = self.params()
        p.pop("dataSource")
        with mock.patch.object(fetch, "fetch_features", fake):
            with self.assertRaises(PipelineError) as c:
                pipeline.generate(Job("g", Emitter(Sink())), p)
        self.assertEqual(c.exception.code, "NO_DATA")
        self.assertIsNone(seen["source"])

    def test_detail_from_pbf_with_interior(self):
        from voxelworlds.voxel import detail_scene
        gen = self.run_generate(self.params())
        self.assertTrue([e for e in gen.ev if e["type"] == "result"])
        ref = dict(bbox=BBOX, buildingId=f"way/{self.ids['bld_levels']}", metersPerFloor=3.5,
                   defaultBuildingHeight=10.5, dataSource={"kind": "pbf", "regionId": "syn", "pbfPath": self.path})
        sink = Sink()
        detail_scene.run_detail(Job("d", Emitter(sink)),
                                dict(ref=ref, voxelSize=0.25, maxVoxels=20_000_000, interior=dict(enabled=True)))
        res = [e for e in sink.ev if e["type"] == "result"]
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["stats"]["levels"], 4)
        self.assertGreater(res[0]["stats"]["voxelCount"], 1000)

    def test_detail_rebuilds_bbox_from_file_when_cache_is_gone(self):
        from voxelworlds.voxel import detail_scene
        ref = dict(bbox=BBOX, buildingId="way/101", metersPerFloor=3.5, defaultBuildingHeight=10.5,
                   dataSource={"kind": "pbf", "regionId": "syn", "pbfPath": self.path})
        sink = Sink()
        detail_scene.run_detail(Job("d", Emitter(sink)), dict(ref=ref, voxelSize=0.5, maxVoxels=20_000_000))
        self.assertEqual(len([e for e in sink.ev if e["type"] == "result"]), 1)

    def test_detail_file_gone_is_no_data(self):
        from voxelworlds.voxel import detail_scene
        p = os.path.join(self.tmp, "vanish.osm.pbf")
        shutil.copy(self.path, p)
        ref = dict(bbox=BBOX, buildingId="way/101", dataSource={"kind": "pbf", "regionId": "v", "pbfPath": p})
        os.remove(p)
        with self.assertRaises(PipelineError) as c:
            detail_scene.run_detail(Job("d", Emitter(Sink())), dict(ref=ref, voxelSize=0.5, maxVoxels=1_000_000))
        self.assertEqual(c.exception.code, "NO_DATA")

    def test_detail_without_source_keeps_failing_fast_on_missing_overpass_cache(self):
        from voxelworlds.voxel import detail_scene
        ref = dict(bbox=BBOX, buildingId="way/101")
        with self.assertRaises(PipelineError) as c:
            detail_scene.run_detail(Job("d", Emitter(Sink())), dict(ref=ref, voxelSize=0.5, maxVoxels=1_000_000))
        self.assertEqual(c.exception.code, "NO_DATA")


class Unwind(unittest.TestCase):
    def test_run_blocking_waits_for_the_worker_to_unwind_before_raising(self):
        sink = Sink()
        job = Job("u", Emitter(sink))
        cleaned = []

        def work():
            while not job.cancel_event.is_set():
                time.sleep(0.01)
            time.sleep(0.3)               # slow unwinding (flush / close / unlink)
            cleaned.append(1)
        threading.Timer(0.1, job.cancel_event.set).start()
        with self.assertRaises(Cancelled):
            job.run_blocking(work, "x", unwind=2.0)
        self.assertEqual(cleaned, [1])

    def test_default_still_abandons_immediately(self):
        job = Job("u", Emitter(Sink()))
        threading.Timer(0.1, job.cancel_event.set).start()
        t = time.monotonic()
        with self.assertRaises(Cancelled):
            job.run_blocking(lambda: time.sleep(1.0), "x")
        self.assertLess(time.monotonic() - t, 0.6)


class StaleOverpassCache(unittest.TestCase):
    """Detail (only) may use an expired but present OSM cache for the exact bbox."""

    def setUp(self):
        import test_detail_scene as T
        self.T = T
        self.d = tempfile.mkdtemp(prefix="vw-stale-")
        self._env = mock.patch.dict(os.environ, {"VOXEL_CACHE_DIR": self.d, "VOXEL_TMP_DIR": self.d})
        self._env.start()
        cache._ROOT = None
        self.addCleanup(self._env.stop)
        self.addCleanup(shutil.rmtree, self.d, True)
        self.addCleanup(setattr, cache, "_ROOT", None)
        self.boxes = fetch.chunk_boxes(T.BBOX, CFG)

    def put(self, age_days, roads=1):
        for box in self.boxes:
            key = "osm|v6-manmade|%.6f,%.6f,%.6f,%.6f|roads=%d" % (*box, roads)
            cache.put_obj("osm", key, self.T.synthetic_gdf())
            t = time.time() - age_days * 86400
            os.utime(cache._path("osm", key), (t, t))

    def test_fresh_vs_stale_visibility(self):
        self.put(30)
        self.assertFalse(fetch.cached_any(self.T.BBOX, CFG))
        self.assertFalse(fetch.cached_roads_variant(self.T.BBOX, CFG))
        self.assertTrue(fetch.cached_any(self.T.BBOX, CFG, allow_stale=True))
        self.assertTrue(fetch.cached_roads_variant(self.T.BBOX, CFG, allow_stale=True))
        self.assertAlmostEqual(time.time() - fetch.oldest_cached(self.T.BBOX, CFG), 30 * 86400, delta=60)

    def test_generate_path_keeps_the_ttl(self):
        self.put(30)
        with mock.patch.object(fetch, "_MIN_GAP_S", 0.0), mock.patch.object(fetch.time, "sleep"):
            # an expired entry is not returned without allow_stale (the network path would be taken)
            self.assertIsNone(cache.get_obj("osm", "osm|v6-manmade|%.6f,%.6f,%.6f,%.6f|roads=1" % self.boxes[0],
                                            CFG.osm_cache_ttl_s))
        g = fetch.fetch_features(self.T.BBOX, True, CFG, threading.Event(), allow_stale=True)
        self.assertEqual(len(g), 5)

    def test_stale_fetch_never_goes_to_the_network(self):
        with self.assertRaises(PipelineError) as c:
            fetch.fetch_features(self.T.BBOX, True, CFG, threading.Event(), allow_stale=True)
        self.assertEqual(c.exception.code, "NO_DATA")

    def run_detail(self):
        from voxelworlds.voxel import detail_scene
        sink = Sink()
        detail_scene.run_detail(Job("d", Emitter(sink)),
                                dict(ref=dict(bbox=self.T.BBOX, buildingId="way/101"), voxelSize=0.5,
                                     maxVoxels=20_000_000))
        return sink

    def test_detail_uses_expired_cache_with_warning(self):
        self.put(30)
        sink = self.run_detail()
        self.assertEqual(len([e for e in sink.ev if e["type"] == "result"]), 1)
        w = [e for e in sink.ev if e["type"] == "warning" and e["code"] == "OSM_CACHE_STALE"]
        self.assertEqual(len(w), 1)
        day = time.strftime("%Y-%m-%d", time.localtime(time.time() - 30 * 86400))
        self.assertEqual(w[0]["message"], f"Using saved OSM data from {day} for this world.")

    def test_detail_fresh_cache_has_no_warning(self):
        self.put(1)
        sink = self.run_detail()
        self.assertFalse([e for e in sink.ev if e.get("code") == "OSM_CACHE_STALE"])
        self.assertEqual(len([e for e in sink.ev if e["type"] == "result"]), 1)

    def test_detail_without_any_cache_fails_fast(self):
        with self.assertRaises(PipelineError) as c:
            self.run_detail()
        self.assertEqual(c.exception.code, "NO_DATA")


class IndexCodec(unittest.TestCase):
    def test_segment_roundtrip_wide_deltas(self):
        """Features spanning > 214 degrees need 64-bit deltas; coordinates still round-trip exactly."""
        import shapely
        coords = np.array([[-179.9999999, 10.0], [179.9999999, 10.5], [0.1234567, -80.0]])
        ints = np.rint(coords * 1e7).astype(np.int32)
        item = (pbf.KIND_WAY | (pbf._G_LINE << 2), 7, {"highway": "x"}, 3, ints.tobytes())
        blob = pbf._enc_segment([item])
        out = pbf._dec_segment(blob, dict(latMin=-90, lonMin=-180, latMax=90, lonMax=180), set())
        self.assertEqual(len(out), 1)
        np.testing.assert_array_equal(np.asarray(out[0][3].coords), ints / 1e7)

    def test_dedup_across_segments(self):
        item = (pbf.KIND_NODE | (pbf._G_POINT << 2), 5, {"entrance": "yes"}, 1,
                np.array([[85_000_000, 473_000_000]], np.int32).tobytes())
        blob = pbf._enc_segment([item])
        seen = set()
        bb = dict(latMin=47, lonMin=8, latMax=48, lonMax=9)
        self.assertEqual(len(pbf._dec_segment(blob, bb, seen)), 1)
        self.assertEqual(len(pbf._dec_segment(blob, bb, seen)), 0)


if __name__ == "__main__":
    unittest.main()
