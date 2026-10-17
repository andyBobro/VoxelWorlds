"""Mirror rotation / failure handling for the Overpass fetch (osmnx mocked) + e2e on the Haifa-area bbox."""
import os
import sys
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from voxelworlds.config import Config  # noqa: E402
from voxelworlds.osm import fetch  # noqa: E402
from voxelworlds.protocol import PipelineError  # noqa: E402

BBOX = dict(latMin=32.83196, latMax=32.83296, lonMin=34.97741, lonMax=34.97857)


class FakeOx:
    def __init__(self, bad):
        self.bad = bad
        self.calls = []
        self.settings = mock.Mock()

    def features_from_bbox(self, bbox, tags):
        url = self.settings.overpass_url
        self.calls.append(url)
        if any(b in url for b in self.bad):
            raise RuntimeError(f"'{url}' responded: 500 Internal Server Error")
        import geopandas as gpd
        return gpd.GeoDataFrame(geometry=[], crs=4326)


class MirrorTests(unittest.TestCase):
    def setUp(self):
        fetch._BAD_UNTIL.clear()
        self.cfg = Config(overpass_urls=("https://a/api", "https://b/api", "https://c/api"), overpass_retries=5)
        self.patches = [mock.patch.object(fetch, "_MIN_GAP_S", 0.0), mock.patch.object(fetch.cache, "get_obj", return_value=None),
                        mock.patch.object(fetch.cache, "put_obj"), mock.patch.object(fetch.time, "sleep")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        mock.patch.stopall()

    def _run(self, bad):
        ox = FakeOx(bad)
        stop = threading.Event()
        stop.wait = lambda d: False  # no real backoff
        with mock.patch.dict(sys.modules, {"osmnx": ox, "osmnx._errors": mock.Mock(InsufficientResponseError=KeyError)}):
            fetch._fetch_chunk((34.977, 32.831, 34.978, 32.832), True, self.cfg, stop)
        return ox.calls

    def test_skips_dead_mirrors(self):
        calls = self._run(bad=["//a/", "//b/"])
        self.assertEqual(calls, ["https://a/api", "https://b/api", "https://c/api"])

    def test_dead_mirror_not_retried_while_cooling(self):
        self._run(bad=["//a/"])
        calls = self._run(bad=["//a/"])  # new key? same key is cached-miss mock; a is cooling
        self.assertNotIn("https://a/api", calls)

    def test_all_dead_raises_osm_failed(self):
        with self.assertRaises(PipelineError) as cm:
            self._run(bad=["//a/", "//b/", "//c/"])
        self.assertEqual(cm.exception.code, "OSM_FAILED")

    def test_config_has_no_whitelist_only_mirror(self):
        from voxelworlds.config import DEFAULT_CONFIG as c
        self.assertFalse(any("openstreetmap.fr" in u for u in c.overpass_urls))


if __name__ == "__main__":
    unittest.main()
